// skills_core.js - Discovery, parsing, and management of .agent/skills/<skill>/SKILL.md files.

function parseFrontmatter(frontmatterStr) {
    const result = {};
    const lines = (frontmatterStr || '').split(/\r?\n/);
    let currentKey = null;
    let currentValue = [];

    for (const line of lines) {
        const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
        if (kvMatch) {
            if (currentKey) {
                result[currentKey] = currentValue.join(' ').trim();
            }
            currentKey = kvMatch[1].toLowerCase();
            const val = kvMatch[2].trim();
            currentValue = val ? [val] : [];
        } else if (currentKey && /^\s+/.test(line)) {
            currentValue.push(line.trim());
        }
    }
    if (currentKey) {
        result[currentKey] = currentValue.join(' ').trim();
    }
    for (const k of Object.keys(result)) {
        let v = result[k];
        if (v.startsWith('>') || v.startsWith('|')) {
            v = v.slice(1).trim();
        }
        v = v.replace(/^['"]|['"]$/g, '').trim();
        result[k] = v;
    }
    return result;
}

function parseSkillFile(content, filepath) {
    const text = String(content || '').trim();
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    let name = '';
    let description = '';
    let body = text;

    if (match) {
        const meta = parseFrontmatter(match[1]);
        if (meta.name) name = meta.name;
        if (meta.description) description = meta.description;
        body = match[2].trim();
    }

    if (!name && filepath) {
        const parts = filepath.replace(/\\/g, '/').split('/');
        if (parts.length >= 2) {
            const dirName = parts[parts.length - 2];
            if (dirName && dirName !== 'skills') {
                name = dirName;
            }
        }
    }
    if (!name) name = 'unnamed-skill';
    name = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

    return {
        name,
        description: description || 'No description provided.',
        body,
        path: filepath || '',
        raw: text
    };
}

async function scanWorkspaceSkills() {
    if (!window.state) return {};
    if (!window.state.skills) window.state.skills = {};

    const skillsDir = window.SKILLS_DIR || '.agent/skills';
    const allPaths = new Set([
        ...Object.keys(window.registry?.meta || {}),
        ...Object.keys(window.registry?.files || {})
    ]);

    const skillFilePaths = [];
    for (const p of allPaths) {
        const norm = p.replace(/\\/g, '/');
        if (!norm.startsWith(skillsDir + '/')) continue;
        const fileName = norm.split('/').pop().toLowerCase();
        if (fileName === 'skill.md') {
            skillFilePaths.push(p);
        }
    }

    const nextSkills = {};
    for (const fp of skillFilePaths) {
        try {
            let content = window.registry?.files?.[fp];
            if (content === undefined && typeof window.readFileContent === 'function') {
                content = await window.readFileContent(fp);
            }
            if (content && typeof content === 'string') {
                const parsed = parseSkillFile(content, fp);
                if (parsed && parsed.name) {
                    nextSkills[parsed.name] = parsed;
                }
            }
        } catch (e) {
            console.warn('Failed to read skill at', fp, e);
        }
    }

    window.state.skills = nextSkills;
    return nextSkills;
}

function getAvailableSkills() {
    return Object.values(window.state?.skills || {});
}

function getSkillByName(name) {
    if (!name || !window.state?.skills) return null;
    const clean = String(name).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    return window.state.skills[clean] || Object.values(window.state.skills).find(s => s.name.toLowerCase() === clean.toLowerCase()) || null;
}

function formatSkillsSystemPromptSection() {
    const skills = getAvailableSkills();
    if (!skills.length) return '';

    const list = skills.map(s => `- \`${s.name}\`: ${s.description}`).join('\n');
    return `\n\n## Available Skills\n<available_skills>\n${list}\n</available_skills>\nWhen a task matches an available skill, invoke the load_skill tool with its name to load its instructions and guidelines before proceeding.\n`;
}

function getSkillsAutocompleteMatches(query) {
    const q = (query || '').toLowerCase();
    const isPrefixed = q.startsWith('/skill:');
    const searchTerm = isPrefixed ? q.slice(7) : (q.startsWith('/skill') ? q.slice(6).trim() : q.replace(/^\//, ''));

    const skills = getAvailableSkills();
    const filtered = skills.filter(s => {
        if (!searchTerm) return true;
        return s.name.toLowerCase().includes(searchTerm) || s.description.toLowerCase().includes(searchTerm);
    });

    return filtered.map(s => ({
        type: 'skill',
        value: `/skill:${s.name} `,
        title: `/skill:${s.name}`,
        desc: s.description
    }));
}

// --- AST_EXPORTS_START ---
window.parseFrontmatter = parseFrontmatter;
window.parseSkillFile = parseSkillFile;
window.scanWorkspaceSkills = scanWorkspaceSkills;
window.getAvailableSkills = getAvailableSkills;
window.getSkillByName = getSkillByName;
window.formatSkillsSystemPromptSection = formatSkillsSystemPromptSection;
window.getSkillsAutocompleteMatches = getSkillsAutocompleteMatches;
// --- AST_EXPORTS_END ---

export {
    parseFrontmatter,
    parseSkillFile,
    scanWorkspaceSkills,
    getAvailableSkills,
    getSkillByName,
    formatSkillsSystemPromptSection,
    getSkillsAutocompleteMatches
};