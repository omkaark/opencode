# Clone Tool (Subagent Smith)

A tool that allows the main agent to clone itself, creating a copy with the exact same conversation context. The clone executes a task autonomously and returns a summary back to the main agent.

## Motivation

The existing Task tool (`task.ts`) spawns subagents with **empty sessions** — the subagent starts fresh with no conversation history and only knows what's in the prompt. This is fine for specialized agents with narrow scopes, but it means the subagent lacks all the context the main agent has accumulated: what files have been discussed, what decisions were made, what the user's preferences are, etc.

The Clone tool solves this by **forking the session** — the clone gets a complete copy of the conversation up to the point of cloning. It doesn't know it's a clone. It receives the prompt as if the user typed it, does work, and returns a summary.

## How It Works

### Step-by-step flow

1. **Main agent invokes the clone tool** with a `description` and `prompt`
2. **Session fork**: `Session.fork()` copies all messages and their parts from the parent session into a new session. The `messageID` parameter cuts off at the current assistant message (the one containing the clone tool call), so the clone never sees the tool invocation itself.
3. **Parent link**: `Session.setParentID()` marks the forked session as a child of the parent session
4. **Title**: `Session.setTitle()` names the clone session `"<description> (clone)"`
5. **Prompt injection**: The user's prompt is appended with a summary instruction and passed through `SessionPrompt.resolvePromptParts()` to handle any file/agent references
6. **Execution**: `SessionPrompt.prompt()` injects the prompt as a user message in the forked session and runs the standard LLM loop
7. **Tool restrictions**: None. The clone has full access to all tools including clone, task, todowrite, etc.
8. **Result extraction**: The last text part of the clone's response is extracted and returned to the main agent wrapped in `<clone_result>` tags

### Key design decisions

- **No agent selection**: Unlike the Task tool, the clone IS the main agent. There's no `subagent_type` parameter.
- **Same model**: The clone uses the same model/provider as the parent's current assistant message.
- **Recursive cloning**: Clones can clone themselves and use the Task tool — no artificial restrictions on tool access.
- **Summary instruction**: A `SUMMARY_INSTRUCTION` is appended to every prompt, asking the clone to end with a summary of changes, decisions, and things to review.
- **Permission-based access control**: Uses `permission: "clone"` so it can be independently enabled/disabled via the permission system.

### Session fork mechanics

`Session.fork()` (in `session/index.ts`) does the following:
- Creates a new session with a new ID (no parent by default — that's set separately)
- Iterates all messages in the source session chronologically
- For each message before the cutoff (`msg.info.id >= messageID` breaks):
  - Generates a new MessageID
  - Clones the message with remapped IDs (including assistant `parentID` references)
  - Clones all parts with new PartIDs
- Returns the new session

The cutoff uses `>=` comparison, so the message with the specified ID is **excluded**. This means the clone sees everything up to but not including the assistant message that invoked the clone.

## Files

### New files

| File | Purpose |
|------|---------|
| `packages/opencode/src/tool/clone.ts` | Clone tool implementation — fork, configure, prompt, return result |
| `packages/opencode/src/tool/clone.txt` | Tool description shown to the LLM — when to use, examples, usage notes |

### Modified files

| File | Change |
|------|--------|
| `packages/opencode/src/tool/registry.ts` | Import `CloneTool` and add it to the `all()` tool list |
| `packages/opencode/src/session/index.ts` | Added `Session.setParentID()` to update a session's parent after creation |

### Unchanged files

| File | Notes |
|------|-------|
| `packages/opencode/src/tool/task.ts` | Left exactly as dev — the Task tool is untouched |

## Architecture Diagram

```
Main Agent Session
  |
  |-- [user message] "Refactor auth and update tests"
  |-- [assistant message] "I'll clone myself to work on both..."
  |     |
  |     |-- clone tool call (description="Refactor auth", prompt="...")
  |     |     |
  |     |     |-- Session.fork(sessionID, messageID)
  |     |     |     -> New session with all messages BEFORE this assistant message
  |     |     |
  |     |     |-- setParentID, setTitle
  |     |     |
  |     |     |-- SessionPrompt.prompt(forked session, augmented prompt)
  |     |     |     -> Clone runs autonomously (doesn't know it's a clone)
  |     |     |     -> Clone finishes with summary
  |     |     |
  |     |     |-- Extract last text part -> <clone_result>
  |     |     |
  |     |     +-- Return result to main agent
  |     |
  |     |-- clone tool call (description="Update tests", prompt="...")
  |     |     |
  |     |     +-- (same flow, independent session)
  |     |
  |-- [assistant message] "Here's what the clones did: ..."
```

## Comparison: Clone vs Task

| | Clone Tool | Task Tool |
|---|---|---|
| Context | Full conversation history | Empty session |
| Agent | Same as parent | Selectable (specialized agents) |
| Model | Same as parent | Agent-configured or inherited |
| Use case | Parallel work needing context | Specialized subtasks |
| Recursive | Can clone itself and use all tools | Configurable per agent |
| Prompt style | Direct (context is shared) | Must be self-contained |

## Future Considerations

- **Configuring which tool the main LLM can use**: Task, Clone, both, or neither — via agent permission configuration
- **Recursive cloning depth limits**: Clones can currently clone indefinitely. Depth limits could prevent runaway chains.
- **Clone-to-clone communication**: Clones are independent. A coordination mechanism could enable collaborative workflows.
