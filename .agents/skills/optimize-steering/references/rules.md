# Agent Optimization Rules -- Rationale

## R1: Frontmatter

Every file must have YAML frontmatter with a `description` field.

**Why**: The description is the primary mechanism agents use to decide whether to load a file. A good description says what the file contains AND when to load it. Third person, present tense. For skills: be specific about triggers -- mention keywords the user might say.

## R2: Language

- Reserve `MUST`/`NEVER`/`ALWAYS`/`CRITICAL` only for safety issues (secrets, data loss, destructive ops)
- Remove model family names
- Replace vendor paths with shared equivalents (`~/.<vendor>/` -> `~/.config/agentic-tools/`, `<VENDOR>.md` -> `AGENTS.md`)
- Frame as actions to take, not things to avoid
- For non-obvious rules, add a brief reason

**Why**: ALL CAPS causes overtriggering on current models. Model names bias toward one vendor's behavior -- cross-model prompts degrade 27-39% when transferred. Negative instructions backfire: attention mechanisms highlight forbidden concepts. A reason outperforms a heavy-handed directive.

## R3: Structure

- Tables for mappings (tool selections, phase routing, choices)
- Bullets for rules and constraints
- No prose paragraphs -- convert to scannable structures
- Maximum three heading levels

**Why**: Tables reduce comprehension time vs prose. Structured formats are strictly better for agent skimming.

## R4: Template

Every file of the same type follows the same section structure. Steering files use routing tables and bullet lists. Skills use imperative form throughout. Agent definitions use third-person role descriptions with capability bullet lists.

**Why**: Format beats content -- agents respond to consistent structure more than specific wording.

## R5: Cross-References

- Steering files: relative paths from the steering root
- Skills and agents: backtick-wrapped canonical names
- Consistent naming throughout -- no synonym drift

**Why**: Unambiguous routing prevents agents from loading wrong files or missing dependencies.

## R6: File Size

Target under 50 lines. Split files with two distinct topics, routing + detail content, or multiple independent tables. Compress by merging similar rules, removing redundant explanations, and tightening table cells.

**Why**: Files over 50 lines consume tokens for content the agent may not need. Progressive disclosure loads only relevant detail.

## R7: Progressive Disclosure

Index files contain routing tables only -- what file covers what topic, when to load it. No rules or procedures inline. Three-tier loading: L0 index (always), L1 phase docs (when active), L2 references (when consulted).

**Why**: Progressive disclosure delivers 60-80% token reduction and 80%+ instruction compliance improvement.
