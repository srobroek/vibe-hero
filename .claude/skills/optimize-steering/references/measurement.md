# Measurement Reference

## Token Estimation

Estimate tokens as `word_count * 1.3`. For precise counts, pipe through the project's tokenizer if available.

## Load Types

| Load Type | When Read | Token Impact |
|-----------|-----------|-------------|
| Eager | Every session start | Highest -- minimize aggressively |
| Agent | When skill invoked | Medium -- one skill per phase |
| Lazy | When rule/procedure referenced | Lowest -- load only when needed |

## Redundancy Detection

Search for content duplicated across files: identical paragraphs, same rules in different words, code templates repeated across skill files, protocol descriptions duplicated per-agent. Use key phrase searches from eager files to check for echoes elsewhere.

## Report Format

Output a markdown report with:
- Summary: total files, lines, estimated tokens, eager token count, redundancy rate
- File inventory table: file, lines, tokens, load type
- Redundancy map: duplicated content across files
- Prioritized recommendations sorted by token savings
