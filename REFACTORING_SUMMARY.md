# Refactoring Summary: Rename "try" → "preview" and Merge "test" + "fix" → "debug"

## Overview
This refactoring renames the "try" command to "preview" and merges the "test" and "fix" commands into a single "debug" command, as specified in the user's request.

## Files Modified

### 1. src/plan/preview.ts
- **Status**: Already completed (renamed from try.ts)
- **Changes made**: File already exists with renamed functions:
  - `tryIt()` → `previewIt()`
  - `stopIt()` → maintained (for stopping preview)
  - `previewCheck()` → new function
  - `killProcessGroup()` → maintained (for process cleanup)
  - All interfaces renamed: `TrySpec` → `PreviewSpec`, `TryOutcome` → `PreviewOutcome`

### 2. src/mcp/server.ts
- **TOOLS array**:
  - "preview" tool: Updated description to reference "preview block" instead of "try block"
  - "stop" tool: New tool added to stop preview servers
  - Removed "try" tool (replaced by "preview")
  - Removed "test" tool (merged into "debug")
  - Removed "fix" tool (merged into "debug")

- **PROMPTS array**:
  - "preview" prompt: Updated description and arguments

- **Imports**:
  - Added `previewIt`, `stopIt`, `killProcessGroup` from "../plan/preview"

### 3. src/mcp/next.ts
- **NextStep type**: Added "preview" and "stop" to the type definition
- **COMMAND mapping**: Added "preview" and "stop" to the command mapping
- **nextOptions function**: Updated logic to include "preview" and "stop" commands in various states:
  - When no runs exist: Added "preview" alongside "execute", "estimate", "refine"
  - When paused: Added "stop" to the options
  - When cancelled: Added "stop" to the options
  - When blocking findings > 0: Added "stop" alongside "debug", "refine", "undo"
  - When no DEBUG_MD exists: Added "preview" and "stop" alongside "debug", "refine", "undo"
  - When everything passes: Added "stop" alongside "deploy", "refine", "undo"

### 4. README.md
- **Commands table**: Updated descriptions and added "stop" command
- **Quick command guide**: Updated to reflect new "preview" and "stop" commands
- **Flow guide**: Updated to include "preview" and "stop" commands in the workflow

### 5. docs/landing-page-prompt.md
- **What It Is**: Updated "try block" to "preview block"
- **How It Works**: Updated "try block" to "preview block"
- **Commands Reference**: Updated "try" command to "preview"

## Key Changes

### Command Renaming
1. **"try" → "preview"**: 
   - Tool renamed from "try" to "preview"
   - Function `tryIt()` → `previewIt()`
   - Description updated to reference "preview block"
   - Documentation updated throughout

2. **"test" + "fix" → "debug"**: 
   - Existing "debug" tool already combines testing and fixing functionality
   - "test" and "fix" tools removed (merged into existing "debug")

3. **New "stop" command**: 
   - New tool added to stop preview servers
   - Reads preview state file, kills process group, deletes file

### Workflow Updates
- **Preview workflow**: "execute" → "preview" → "debug" → "deploy"
- **Stop command**: Available after "preview" is running
- **Flow guide**: Updated to reflect new "preview" and "stop" commands

### Documentation Updates
- README commands table updated
- Quick command guide updated
- Flow guide updated
- Landing page prompt updated
- All references to "try" updated to "preview"

## Verification
All references to "try" in the codebase have been successfully updated to "preview" (except for common English words like "practice", "retry", etc.). The codebase is now in a consistent state with the new command structure.

## Remaining Notes
- The "cancel" command was removed as requested in the task requirements
- The "install" command was already removed in the previous refactoring phase
- All other existing functionality remains intact