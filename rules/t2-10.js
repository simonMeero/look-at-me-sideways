/* Copyright (c) 2018 Looker Data Sciences, Inc. See https://github.com/looker-open-source/look-at-me-sideways/blob/master/LICENSE.txt */
const getExemption = require('../lib/get-exemption.js');

module.exports = function(
	project,
) {
	let messages = [];
	let ruleIds = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10'];
	let rules = {};
	let allExempted = true;
	for (let rule of ruleIds) {
		rules[rule] = {
			globallyExempt: getExemption(project.manifest, rule),
			matches: 0,
			exemptions: 0,
			errors: 0,
		};
		if (rules[rule].globallyExempt) {
			messages.push({
				rule, level: 'info', location: 'project',
				exempt: rules[rule].globallyExempt,
				path: `/projects/${project.name}/files/manifest.lkml`,
				description: `Project-level exemption: ${rules[rule].globallyExempt}`,
			});
		} else {
			allExempted = false;
		}
	}
	if (allExempted) {
		return {messages};
	}
	let files = project.files || [];
	let pkNamingConvention = (s) => s.match(/^(\d+pk|pk\d+)_.+$/);
	let unique = (x, i, arr) => arr.indexOf(x) == i;
	for (let file of files) {
		let views = Object.values(file.view || {});
		for (let view of views) {
			let location = 'view: ' + view.$name;
			let path = '/projects/' + project.name + '/files/' + file.$file_path + '#view:' + view.$name;
			let sql = view.sql_table_name || view.derived_table && view.derived_table.sql;
			if (!sql) {
				continue;
			}

			let exempt = (ruleId) =>
				getExemption(file, ruleId)
				|| getExemption(view, ruleId)
				|| view.derived_table && getExemption(view.derived_table, ruleId);

			for (let rule of ruleIds) {
				rules[rule].matches++;
				if (exempt(rule)) {
					rules[rule].exemptions++;
				}
			}

			let rulesInMatch = {};
			for (let r of ruleIds) {
				rulesInMatch[r] = {errored: false};
			}

			// Initialize the "stuff to check" by removing any string literals, comments, & LookML
			let remaining = sql
				.replace(/\n\s*-- ?--*\s*\n/g, ',[sep],') // Allow some flexibility in separator because --- is a syntax error in MySQL
				.replace(new RegExp([
					'[^\\\\\']+(\\\\.[^\\\\\']+)*\'',	// ' string literal
					'`[^\\\\`]+(\\\\.[^\\\\`]+)*`',	// ` quoted name
					'"[^\\\\"]+(\\\\.[^\\\\"]+)*"',	// " string literal or quoted name
					'--[^\\n]*(\\n|$)',				// -- Single line comment
					'/\\*[^*]*(\\*[^/][^*]*)*\\*/', // /* Multi-line comment
					'\\${[^}]*}',					// ${} LookML
					'{%.*?%}',						// {%%} Liquid
					'{{.*?}}',						// {{}} Liquid
				].join('|'), 'g'), '[nonsql]'); // TODO: Save the contents somewhere in case they were column names we need later?
			while (remaining) {
				let current;
				const innermostParens = remaining.match(/(^[\s\S]*)(\([^()]*\))([\s\S]*)/);
				if (innermostParens) {
					current = innermostParens[2].slice(1, -1);
					remaining = innermostParens[1] + '[paren]' + innermostParens[3];
				} else {
					current = remaining;
					remaining = false;
				}
				const snippet = current.replace(/\s+/g, ' ').slice(0, 15);
				if (!current.match(/^\s*SELECT\s/)) {
					// Non-subquery parenthetical
					continue;
				}
				if (current.match(/^\s*SELECT\s[^,]+(\bFROM|$)/)) {
					// Single column selects exempt per T9
					messages.push({
						location, path, rule: 'T9', level: 'verbose',
						description: `Single-column subquery (${snippet}...) in ${view.$name} not subject to rule T2 per rule T9`,
					});
					continue;
				}
				if (current.match(/^\s*SELECT\s+\*[\s\S]*?\bFROM\b(?!.*?(,|\bJOIN\b))/)) {
					// Single table *+projections selects exempt per T10
					messages.push({
						location, path, rule: 'T10', level: 'verbose',
						description: `Single-table subquery (${snippet}...) in ${view.$name} not subject to rule T2 per rule T10`,
					});
					continue;
				}
				const aliasRegexpStr = '(' + [
					'[a-zA-Z0-9_$]+',
					'`[^`\\\\n]+`',
					'"[^"\\\\n]+"',
					'\'[^\'\\\\n]+\'',
				].join('|') + ')\\s*$';
				const selections = current
					.replace(/^\s*SELECT\s+/, '').replace(/\s*FROM[\s\S]*$/, '')
					.split(',')
					.map((part) => part.trim().toLowerCase().replace(/\s+/, ' '))
					.filter(Boolean)
					.map((selection) => ({
						expression: selection.replace(new RegExp('\\s+as\\s+' + aliasRegexpStr, 'i'), ''),
						alias: (selection.match(new RegExp(aliasRegexpStr, 'i')) || [''])[0],
					}));
				const groupings = current
					.replace(/^[\s\S]*?(GROUP\s+BY\s+|$)/, '')
					.replace(/\s+(WHERE|HAVING|ORDER\s+BY|LIMIT|WINDOW|$)[\s\S]*$/, '')
					.split(',')
					.map((part) => part.trim().toLowerCase().replace(/\s+/, ' '))
					.filter(Boolean);
				const pks = selections.filter((s) => pkNamingConvention(s.alias));
				const actualPkCount = pks.length;
				if (!exempt('')) {
					if (actualPkCount === 0) {
						rulesInMatch.T2.errored = true;
						messages.push({
							location, path, rule: 'T2', level: 'error', exempt: exempt('T2'),
							description: `No Primary Key columns/selectAliases found in ${view.$name}`,
						});
						continue;
					}
				}
				const pkCountDeclarations = pks
					.map((p) => parseInt(p.alias.match(/\d+/)[0]))
					.filter(unique);
				if (pkCountDeclarations.length > 1) {
					messages.push({
						location, path, rule: 'T3', level: 'error', exempt: exempt('T3') || exempt('T2'),
						description: `Primary Key columns in "${snippet}"  in ${view.$name} have mismatching numbers (${pkCountDeclarations.join(', ')})`,
					});
					continue;
				}
				const declaredPkCount = pkCountDeclarations[0];
				if (actualPkCount !== declaredPkCount) {
					messages.push({
						location, path, rule: 'T3', level: 'error', exempt: exempt('T3') || exempt('T2'),
						description: `Primary Key columns in "${snippet}"  in ${view.$name} declare ${declaredPkCount} column(s), but there are ${actualPkCount}`,
					});
					continue;
				}
				if (!selections.slice(0, pks.length).every((s) => pkNamingConvention(s.alias))) {
					messages.push({
						location, path, rule: 'T4', level: 'error', exempt: exempt('T4') || exempt('T2'),
						description: `Primary Key columns in "${snippet}" in ${view.$name} are not first`,
					});
					continue;
				}

				if (selections[actualPkCount].expression !== '[sep]') {
					messages.push({
						location, path, rule: 'T8', level: 'error', exempt: exempt('T8') || exempt('T2'),
						description: `Primary Key columns/selectAliases in ${view.$name} should finish with ---`,
					});
					// no `continue;` Allow further rule checks to proceed
				}
				if (!groupings.length) {
					messages.push({
						location, path, rule: 'T6', level: 'error', exempt: exempt('T6') || exempt('T2'),
						description: `LAMS cannot currently enforce rule T6. Please use a T6 exemption in ${view.$name} to communicate whether/how the rule is followed in "${snippet}..."`,
					});
					continue;
				}
				let firstPksThatAreGroups = [];
				for (let p = 0; p < pks.length; p++) {
					if (groupings.some((g) => parseInt(g) && g - 1 === p || g === pks[p].expression)) {
						firstPksThatAreGroups.push(pks[p]);
					} else {
						break;
					}
				}
				if (!firstPksThatAreGroups.length) {
					messages.push({
						location, path, rule: 'T5', level: 'error', exempt: exempt('T5') || exempt('T2'),
						description: `Transformation with GROUP BY (${snippet}...) in ${view.$name} does not begin with at least 1 grouped column as part of a primary key"`,
					});
					continue;
				}
				const allGroupsUsed = groupings.every((g) =>
					parseInt(g) && g <= pks.length
					|| pks.some((p) => p.expression === g),
				);
				if (!allGroupsUsed) {
					if (!pks[firstPksThatAreGroups.length]) {
						messages.push({
							location, path, rule: 'T7', level: 'error', exempt: exempt('T7') || exempt('T2'),
							description: `Transformation with GROUP BY (${snippet}...) in ${view.$name} did not use all grouped columns in the pk, and does not continue with additional columns in the pk"`,
						});
						continue;
					}
					let nextCol = pks[firstPksThatAreGroups.length].expression;
					if (!nextCol.match(/\brow_number\s*\[paren]\s+over\s+\[paren]/)) {
						messages.push({
							location, path, rule: 'T7', level: 'error', exempt: exempt('T7') || exempt('T2'),
							description: `Transformation with GROUP BY (${snippet}...) in ${view.$name} did not use all grouped columns in the pk, and the next column is not a ROW_NUMBER window"`,
						});
						continue;
					}
					messages.push({
						location, path, level: 'info', rule: 'T7',
						description: `Transformation with GROUP BY (${snippet}...) in ${view.$name} appears valid, but LAMS does not verify the partition columns used in the window function (T7)`,
					});
				}
			}
		}
	}
	// messages = messages.filter((msg) => !rules[msg.rule].globallyExempt || msg.location == 'project');
	for (let rule of ruleIds) {
		if (rule==='T9' || rule=='T10') {
			continue; // These rules are actually exceptions and not evaluated per se
		}
		messages.push({
			rule, level: 'info',
			description: `Evaluated ${rules[rule].matches} views, with ${rules[rule].exemptions} exempt`,
		});
	}
	return {
		messages,
	};
};
