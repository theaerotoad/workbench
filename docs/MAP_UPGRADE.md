# Forward Plan: Polyglot Codebase Mapping via Tree-sitter Queries

## 1. Architectural Shift
Currently, `map.js` uses an **imperative AST walk**—it traverses the tree and uses `if/else` statements and `.includes()` string matching on node types to guess what a node represents. While this works beautifully for JavaScript/TypeScript, it does not scale to the differing syntax trees of Python, MATLAB, Fortran, HTML, and CSS.

To support true polyglot mapping without breaking the existing JS implementation, we will transition to a **Query-based Architecture**. 

Tree-sitter provides a robust Query Engine (using Scheme-like `.scm` syntax) that allows us to pattern-match the AST. We will define a dictionary of queries mapped to file extensions. 

### The Strategy
1. **Lookup Query:** When parsing a file, check if a specific query string exists for its language.
2. **Execute Query:** If found, use `language.query(queryString)` to extract standard capture names (`@class.name`, `@fn.name`, `@fn.params`, etc.).
3. **Fallback:** If no query is defined for the language, or if the language is `javascript`/`typescript` (until a full query equivalent is written), fall back to the existing, highly-tuned imperative `walk()` logic. This guarantees zero regression.

---

## 2. Language-Specific Query Definitions

Here are the specific Tree-sitter query patterns we will implement for the requested languages.

### Python (`.py`)
Python's AST is very clean. We can easily capture classes, functions, async definitions, and parameters.

```scheme
; Capture classes
(class_definition 
  name: (identifier) @class.name)

; Capture async and standard functions
(function_definition 
  name: (identifier) @fn.name 
  parameters: (parameters) @fn.params) @fn.def

; We check if the @fn.def node starts with 'async' in JS post-processing.

```

### CSS (`.css`)

For CSS, the "structure" of the file is defined by its selectors and at-rules (like media queries).

```scheme
; Capture rule sets (selectors)
(rule_set 
  selectors: (selectors) @css.selector)

; Capture media queries
(media_statement 
  (media_query) @css.media)

```

*Output Mapping:* `kind: 'rule'`, `name: '.my-class, #app'`, `ln: 45`.

### HTML (`.html`)

Mapping HTML usually means looking for structural landmarks, specifically elements with `id` attributes or semantic tags (`<main>`, `<nav>`, `<template>`).

```scheme
; Capture elements with an ID attribute
(element 
  (start_tag 
    (tag_name) @html.tag
    (attribute 
      (attribute_name) @attr.name (#eq? @attr.name "id")
      (quoted_attribute_value) @attr.value))) @html.element

```

*Output Mapping:* `kind: 'tag'`, `name: 'div#app-container'`, `ln: 12`.

### Fortran (`.f`, `.f90`)

Fortran's structure relies on modules, programs, subroutines, and functions.

```scheme
; Capture Modules
(module_statement 
  name: (identifier) @class.name) ; Map to class for nesting purposes

; Capture Subroutines and Functions
(subroutine_statement 
  name: (identifier) @fn.name)
(function_statement 
  name: (identifier) @fn.name)

```

*Note on WASM:* Fortran `.wasm` parsers are less common on default CDNs. We will use `https://cdn.jsdelivr.net/npm/tree-sitter-wasms/out/tree-sitter-fortran.wasm`.

### MATLAB (`.m`)

MATLAB structures revolve around classes, methods, and standalone functions.

```scheme
; Capture Classes
(classdef_statement 
  name: (identifier) @class.name)

; Capture Functions / Methods
(function_definition 
  name: (identifier) @fn.name 
  parameters: (parameters)? @fn.params)

```

*Note on WASM:* We will dynamically load the MATLAB grammar from `@lumis-sh/wasm-matlab` on jsDelivr.

---

## 3. Implementation Plan for `map.js`

When we are ready to implement this, the changes will be localized within `unpacked/tools/map.js`.

### Step 1: Define the Query Dictionary

Add a configuration object mapping languages to their Tree-sitter query strings.

```javascript
const LANGUAGE_QUERIES = {
    python: `
        (class_definition name: (identifier) @class.name)
        (function_definition name: (identifier) @fn.name parameters: (parameters)? @fn.params) @fn.node
    `,
    css: `...`,
    html: `...`,
    // javascript intentionally omitted to trigger the imperative fallback initially
};

```

### Step 2: Update the Parsing Loop

Inside the file processing loop, after `parser.setLanguage(languageCache[langName])`, we will branch the logic:

```javascript
const queryStr = LANGUAGE_QUERIES[langName];
const symbols = [];

if (queryStr) {
    // === NEW PATH: Query Engine ===
    const query = languageCache[langName].query(queryStr);
    const matches = query.matches(tree.rootNode);
    
    // Iterate matches and map `@class.name`, `@fn.name` to our standard JSON format
    for (const match of matches) {
       // Convert match.captures to { kind, name, ln, params }
       // Check for async/exports based on parent nodes
    }
} else {
    // === LEGACY PATH: Imperative Walk ===
    // (The exact code we just perfected for JS/TS)
    symbols.push(...extractSymbols(tree.rootNode));
}

```

### Step 3: Normalize Output

Both branches will yield an array of standard symbol objects: `{ kind, name, ln, params, async, export, members }`. This means the downstream UI rendering and LLM JSON generation code remains **completely untouched**.

## 4. Summary of Benefits

1. **Zero Regression:** JS/TS continues using the highly tailored logic we just perfected.
2. **Infinite Extensibility:** Adding a new language is as simple as adding a 3-line query string to the `LANGUAGE_QUERIES` dictionary. No new Javascript logic is required.
3. **Maintainability:** Declarative queries are significantly easier to debug and maintain than deeply nested imperative tree-walking functions.
