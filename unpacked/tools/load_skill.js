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

function parseSkillText(rawContent, fallbackName, filepath) {
    const text = String(rawContent || '').trim();
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    let name = fallbackName || '';
    let description = '';
    let body = text;

    if (match) {
        const lines = match[1].split(/\r?\n/);
        for (const line of lines) {
            const m = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
            if (m) {
                const k = m[1].toLowerCase();
                const v = m[2].replace(/^['">|]|['"]$/g, '').trim();
                if (k === 'name' && v) name = v;
                if (k === 'description' && v) description = v;
            }
        }
        body = match[2].trim();
    }

    if (!name && filepath) {
        const parts = filepath.replace(/\\/g, '/').split('/');
        if (parts.length >= 2) {
            const dir = parts[parts.length - 2];
            if (dir && dir !== 'skills') name = dir;
        }
    }

    name = (name || 'unnamed-skill').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    return { name, description, body, path: filepath };
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

    // 1. Check window state if running in main thread
    if (typeof window !== 'undefined') {
        if (typeof window.getSkillByName === 'function') {
            skill = window.getSkillByName(skillName);
        }
        if (!skill && window.state?.skills) {
            skill = window.state.skills[skillName];
        }
    }

    // 2. Direct path read candidates (worker or main thread)
    if (!skill) {
        const candidatePaths = [
            `.agent/skills/${rawName}/SKILL.md`,
            `.agent/skills/${rawName}/skill.md`,
            `.agent/skills/${skillName}/SKILL.md`,
            `.agent/skills/${skillName}/skill.md`
        ];

        for (const p of candidatePaths) {
            try {
                const text = await api.readFile(p);
                if (text && typeof text === 'string' && !text.startsWith('ERROR:')) {
                    skill = parseSkillText(text, skillName, p);
                    break;
                }
            } catch (e) {}
        }
    }

    // 3. Fallback scan via api.listFiles() to handle directory name or casing differences
    if (!skill && typeof api.listFiles === 'function') {
        try {
            const files = await api.listFiles();
            for (const f of files) {
                const norm = f.replace(/\\/g, '/');
                const parts = norm.split('/');
                if (parts.length >= 4 && parts[0] === '.agent' && parts[1] === 'skills') {
                    const dir = parts[2].toLowerCase().replace(/[^a-z0-9_-]/g, '-');
                    const file = parts[3].toLowerCase();
                    if ((dir === skillName || dir === rawName.toLowerCase()) && file === 'skill.md') {
                        const text = await api.readFile(f);
                        if (text && typeof text === 'string' && !text.startsWith('ERROR:')) {
                            skill = parseSkillText(text, parts[2], f);
                            break;
                        }
                    }
                }
            }
        } catch (e) {}
    }

    // 4. If still not found, enumerate existing skills from file list for a helpful error
    if (!skill) {
        let available = [];
        try {
            if (typeof api.listFiles === 'function') {
                const files = await api.listFiles();
                available = files
                    .filter(f => f.startsWith('.agent/skills/') && f.toLowerCase().endsWith('skill.md'))
                    .map(f => f.split('/')[2])
                    .filter(Boolean);
            }
        } catch (e) {}

        const availMsg = available.length ? ` Available skills: ${[...new Set(available)].join(', ')}` : ' No skills found in .agent/skills/.';
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