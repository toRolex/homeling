# Homeling

OpenAI Dots / Grok Bot / Muse 这类 persona agent 的开源实现。详见 `PRD.md`。

## Agent skills

### Issue tracker

Issue 与 spec 存放在 GitHub Issues，通过 `gh` CLI 读写。详见 `docs/agents/issue-tracker.md`。

### Triage labels

默认五个 triage 标签（`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`）。详见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：根目录 `GLOSSARY.md` + `docs/adr/`。详见 `docs/agents/domain.md`。

### Implementation notes

实现决策与因果记录存放在 `.agents/notes/`，记录决策、取舍与偏离，供下一次尝试学习。
