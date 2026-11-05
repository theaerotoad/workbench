# Agent Skills System (`SKILL.md`) Architecture & Implementation Plan

## 1. Overview & Objective

The goal is to introduce an extensible **Skills System** to the Workbench coding agent. Users can drop standard `SKILL.md` bundles into `.agent/skills/<skill-name>/SKILL.md`. The agent will:
1. Automatically discover, index, and parse YAML frontmatter for all workspace skills.
2. Inject a lightweight summary of available skills (`<available_skills>`) into the system prompt across all prompt modes (`code`, `plan`, `ask`).
3. Provide a built-in `load_skill` tool that allows the LLM to dynamically fetch full instructions and guidelines on-demand when a relevant task arises.
4. Support direct user invocation via slash commands (e.g., `/skill:<name>` or `/skill <name> [prompt]`) with live autocomplete.
5. Ensure proper `.agent` visibility, VFS registration, and permission guardrails so skill files are protected from accidental mutation while remaining accessible to tools.

---

## 2. Directory Layout & SKILL.md Specification

### 2.1 File System Convention
All skills reside within the workspace under `.agent/skills/`:
```text
.agent/
└── skills/
    ├── react-patterns/
    │   └── SKILL.md
    ├── database-migrations/
    │   └── SKILL.md
    └── api-designer/
        └── SKILL.md

```

### 2.2 Canonical SKILL.md Schema

Each `SKILL.md` file uses standard YAML frontmatter between `---` fences followed by Markdown body:

```markdown
---
name: react-patterns
description: Best practices for React 18+ components, custom hooks, and state management. Use when creating or refactoring React UI components.
---

# React Patterns Skill

## Overview
Guidelines for writing idiomatic, performant React components in this project.

## Guidelines
- Favor composition over inheritance.
- Use named exports for components and custom hooks.
- Keep components focused on a single responsibility.

## Examples
- Custom hook pattern: `useWorkspaceQuery`
- State reducer pattern: `taskRunnerReducer`

```

### 2.3 Parsing Rules

* **Frontmatter Delimiters**: Must start with `---` on line 1, ending with the next `---`.
* **Fields**:
* `name` *(string)*: Unique identifier for the skill (alphanumeric, hyphens, underscores). If omitted, falls back to the parent directory name.
* `description` *(string)*: One or two sentences explaining what the skill provides and when the model should invoke it.


* **Body**: Everything following the closing `---` constitutes the skill's instructions, guidelines, and examples.

---

## 3. Architecture & Data Flow

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. Workspace Scan / File Change                                        │
│    - Scans .agent/skills/**/SKILL.md                                   │
│    - parseSkillFrontmatter() extracts name, description, and body      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2. In-Memory Registry (skills_core.js)                                 │
│    - state.skills = { [skillName]: { name, description, path, body } } │
│    - Exposes getAvailableSkills(), getSkillByName(), refreshSkills()   │
└───────────────┬───────────────────┴───────────────────┬────────────────┘
                │                                       │
                ▼                                       ▼
┌─────────────────────────────────┐   ┌──────────────────────────────────┐
│ 3. System Prompt Generation     │   │ 4. User Interaction (Chat Input) │
│    (prompt_modes.js)            │   │    (chat_input.js)               │
│    - Injects <available_skills> │   │    - Autocomplete /skill:<name>  │
│      list into system prompt    │   │    - Prepend skill instructions  │
└───────────────┬─────────────────┘   └─────────────────┬────────────────┘
                │                                       │
                ▼                                       ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 5. Model Execution & Built-in `load_skill` Tool                        │
│    - LLM decides to call `load_skill({ skill_name })`                  │
│    - Tool returns instructions & displays UI card in chat              │
└────────────────────────────────────────────────────────────────────────┘

```

---

## 4. Key Components to Implement

### 4.1 Skill Discovery & Management (`unpacked/js/modules/skills_core.js`)

Create a new core module responsible for skill state and parsing:

* **`SKILLS_DIR` constant**: `'.agent/skills'`.
* **`parseSkillFile(content, filepath)`**:
* Regex or line-based parser to split YAML frontmatter from Markdown body.
* Extracts `name` and `description`.
* Normalizes skill name (`toLowerCase()`, replacing invalid characters with hyphens).


* **`scanWorkspaceSkills()`**:
* Iterates over `registry.files` matching `^\.agent\/skills\/[^/]+\/SKILL\.md$`.
* Populates `state.skills[skillName]`.


* **`formatSkillsSystemPromptSection()`**:
* Generates the XML prompt segment to append to mode system prompts:
```markdown
## Available Skills
<available_skills>
- `react-patterns`: Best practices for React 18+ components, custom hooks, and state management.
- `database-migrations`: Schema migration workflows and safety checks.
</available_skills>
When a task matches an available skill, invoke the `load_skill` tool with its name to view full instructions before proceeding.

```




* **Lifecycle Integration**:
* Called during `syncWorkspace()`, `ensureWorkspaceFresh()`, and whenever a file under `.agent/skills/` is saved or deleted.



---

### 4.2 System Prompt Integration (`unpacked/js/modules/prompt_modes.js`)

Update `buildDynamicSystemPrompt(modeOverride)`:

* In `buildDynamicSystemPrompt`:
* Fetch available skills using `formatSkillsSystemPromptSection()`.
* If any skills exist, append the section to the mode's prompt template.


* Add skills reference to the `/help` command text.

---

### 4.3 Built-in Tool: `load_skill` (`unpacked/tools/load_skill.js`)

Implement the `load_skill` tool adhering to the Ion Tool Specification:

* **`TOOL_META`**:
```javascript
const TOOL_META = {
    name: "load_skill",
    description: "Load detailed instructions, guidelines, and domain knowledge for a specific skill from .agent/skills/<skill_name>/SKILL.md.",
    parameters: {
        type: "object",
        properties: {
            skill_name: {
                type: "string",
                description: "The name of the skill to load (as listed in <available_skills>)."
            }
        },
        required: ["skill_name"]
    },
    modes: ["plan", "ask", "code"],
    permission: "always",
    toolBox: 1
};

```


* **`handler(args, api)`**:
1. Retrieve `args.skill_name`.
2. Locate matching skill in registry or read `.agent/skills/<skill_name>/SKILL.md`.
3. Format the display UI card:
* Header: `auto_awesome` or `psychology` icon, skill name badge, and target path.
* Body: Summary of guidelines or collapsible preview of instructions.


4. Return output containing the complete Markdown instructions to the model.



---

### 4.4 Slash Command & Autocomplete (`unpacked/js/modules/chat_input.js`)

Support user-driven skill activation via `/skill:<name>` or `/skill <name>`:

* **Autocomplete Detection (`checkAutocomplete.js`)**:
* When input begins with `/skill` or `/skill:`:
* Match available skill names from `state.skills`.
* Present autocomplete items with `type: 'skill'`, `title: '/skill:' + name`, and `desc: skill.description`.




* **Command Handling (`submitPrompt.js`)**:
* If user submits `/skill:<name> [user query]` or `/skill <name> [user query]`:
* Retrieve the skill content.
* If a user query follows, construct the prompt with explicit skill instructions injected:
```markdown
[Active Skill: <name>]
<skill_instructions>
\${skill.body}
</skill_instructions>

User Request:
\${userQuery}

```


* If submitted without a query, output a message in chat confirming the skill is loaded and ready for instructions.





---

### 4.5 Path Classification & Guardrails (`unpacked/js/modules/fs_utils.js`)

Update path categorization helpers:

* **`isAgentPath(path)`**: Include `path === SKILLS_DIR || path.startsWith(SKILLS_DIR + '/')`.
* **`isSkillPath(path)`**: New helper to identify `.agent/skills/...`.
* **`shouldHideFromTools(path)`**:
* Exempt `.agent/skills/` from general tool hiding so tools like `read`, `find`, or `load_skill` can access skill docs even when `.agent` configuration files are hidden.


* **`isSecurityProtectedPath(path)`**:
* Prevent destructive write/delete tools from inadvertently modifying installed skills unless explicitly permitted.



---

### 4.6 Registration & Build Integration

1. **`unpacked/js/constants.js`**:
* Define `SKILLS_DIR = '.agent/skills'`.
* Add `'load_skill'` to `BUILTIN_TOOL_NAMES`.


2. **`unpacked/index.template.html`**:
* Add `<script type="text/plain" id="builtin-tool-src-load_skill" src="./tools/load_skill.js"></script>`.


3. **`unpacked/js/modules/tools_registry.js`**:
* Seed `load_skill` during `seedBuiltinToolSources()`.
* Ensure virtual file mapping for `.agent/skills` if in-memory workspaces are used.


4. **`build_esbuild.py`**:
* Verify `replace_tools` bundles `./tools/load_skill.js` into compiled `index.html`.



---

## 5. Step-by-Step Implementation Sequence

1. **Step 1: Constants & Path Helpers**
* In `constants.js`, define `SKILLS_DIR`. Add `'load_skill'` to `BUILTIN_TOOL_NAMES`.
* In `fs_utils.js`, add `isSkillPath` and adjust `isAgentPath` & `shouldHideFromTools`.


2. **Step 2: Core Skills Module**
* Create `unpacked/js/modules/skills_core.js`.
* Implement frontmatter parser, registry cache, and prompt section formatter.
* Wire into `workspace_core.js` (`syncWorkspace` / `refreshPathMeta`).


3. **Step 3: Built-in `load_skill` Tool**
* Create `unpacked/tools/load_skill.js`.
* Add tool script tag to `unpacked/index.template.html`.
* Update `tools_registry.js` to seed and register the new tool.


4. **Step 4: System Prompt Injection**
* In `prompt_modes.js`, update `buildDynamicSystemPrompt` to append available skills.


5. **Step 5: Chat Input & Slash Commands**
* In `chat_input.js`, enhance `checkAutocomplete`, `selectAutocompleteItem`, and `submitPrompt` to handle `/skill:<name>`.


6. **Step 6: Build & Verification**
* Run `python build_esbuild.py`.
* Test discovery of sample `SKILL.md`, system prompt injection, `load_skill` execution, and `/skill:` slash command.
