// load_skill - tool definition.
const TOOL_META = {
    "name": "load_skill",
    "description": "Load detailed instructions, guidelines, and domain knowledge for a specific skill from .agent/skills/<skill_name>/SKILL.md.",
    "parameters": {
        "type": "object",
        "properties": {
            "skill_name": {
                "type": "string",
                "description": "The name of the skill to load (as listed in <available_skills>)."
            }
        },
        "required": [
            "skill_name"
        ]
    },
    "modes": [
        "plan",
        "ask",
        "code"
    ],
    "permission": "always",
    "toolBox": 1
};

function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function badge(text, colorVar) {
    return `<span class="tool-ui-badge" style="color:${colorVar}; background:color-mix(in srgb, ${colorVar} 15%, transparent);">${esc(text)}</span>`;
}

async function fail(api, msg) {
    const errorHtml = `
        <div class="tool-ui-wrap">
            <div class="tool-ui-error-wrap">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--red); flex-shrink:0;">warning</span>
                    <span class="tool-ui-path-name">load_skill</span>
                    ${badge('Failed', 'var(--red)')}
                </div>
            </div>
            <div class="tool-ui-error-msg">
                <span class="icon" style="font-size:12px;">error</span>
                <span>${esc(msg)}</span>
            </div>
        </div>`;
    await api.showUI(errorHtml);
    return { output: `ERROR: ${msg}` };
}

async function handler(args, api) {
    const rawName = String(args.skill_name || '').trim();
    if (!rawName) {
        return fail(api, 'skill_name is required.');
    }
    const skillName = rawName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

    let skill = null;
    if (typeof window !== 'undefined') {
        if (typeof window.getSkillByName === 'function') {
            skill = window.getSkillByName(skillName);
        }
        if (!skill && window.state?.skills) {
            skill = window.state.skills[skillName];
        }
    }

    if (!skill) {
        const possiblePaths = [
            `.agent/skills/${rawName}/SKILL.md`,
            `.agent/skills/${rawName}/skill.md`,
            `.agent/skills/${skillName}/SKILL.md`,
            `.agent/skills/${skillName}/skill.md`
        ];

        for (const p of possiblePaths) {
            try {
                const text = await api.readFile(p);
                if (text && typeof text === 'string' && !text.startsWith('ERROR:')) {
                    if (typeof window !== 'undefined' && typeof window.parseSkillFile === 'function') {
                        skill = window.parseSkillFile(text, p);
                    } else {
                        const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
                        skill = {
                            name: skillName,
                            description: '',
                            body: match ? match[2].trim() : text,
                            path: p
                        };
                    }
                    if (typeof window !== 'undefined' && window.state?.skills) {
                        window.state.skills[skill.name] = skill;
                    }
                    break;
                }
            } catch (e) {}
        }
    }

    if (!skill) {
        const available = (typeof window !== 'undefined' && window.state?.skills) ? Object.keys(window.state.skills) : [];
        const availMsg = available.length ? ` Available skills: ${available.join(', ')}` : ' No skills found in .agent/skills/.';
        return fail(api, `Skill "${rawName}" not found.${availMsg}`);
    }

    const header = `Skill: ${skill.name}`;
    await api.setHeaderMsg(header);

    const previewBody = (skill.body || '').slice(0, 400);
    const hasMore = (skill.body || '').length > 400;

    const displayHtml = `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--primary); flex-shrink:0;">auto_awesome</span>
                    <div class="tool-ui-path">
                        <span class="tool-ui-path-name">${esc(skill.name)}</span>
                        ${skill.description ? `<span class="tool-ui-path-dir"> — ${esc(skill.description)}</span>` : ''}
                    </div>
                    ${badge('Skill Loaded', 'var(--green)')}
                </div>
            </div>
            <div class="tool-ui-box" style="padding: 6px 10px; font-size: 11.5px; line-height: 1.45; color: var(--fg); max-height: 180px; overflow-y: auto;">
                <div style="font-weight: 600; color: var(--dim); margin-bottom: 4px; font-size: 10px;">${esc(skill.path || '.agent/skills/' + skill.name + '/SKILL.md')}</div>
                <div style="white-space: pre-wrap; font-family: var(--font-mono); font-size: 11px; opacity: 0.85;">${esc(previewBody)}${hasMore ? '…' : ''}</div>
            </div>
        </div>`;

    await api.showUI(displayHtml);

    const output = `<skill_instructions name="${skill.name}">
# Skill: ${skill.name}
${skill.description ? `Description: ${skill.description}\n` : ''}
${skill.body}
</skill_instructions>`;

    return { output: api.cleanupText(output), summary: header };
}