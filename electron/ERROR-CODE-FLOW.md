# Error Code Preservation Flow

## Before the Fix ❌

```
┌─────────────────────────────────────────────────────────────────┐
│                         RENDERER PROCESS                         │
│                                                                  │
│  ElectronFSAdapter.stat('/projects/untitled')                   │
│         │                                                        │
│         └──────► IPC Call: fs:stat                              │
└─────────────────────────────────────────────────────────────────┘
                           │
                           │ IPC Channel
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                          MAIN PROCESS                            │
│                                                                  │
│  IPC Handler receives: '/projects/untitled'                     │
│         │                                                        │
│         └──────► fs.stat('/home/user/shakespeare/projects/...')│
│                           │                                      │
│                           ▼                                      │
│                  ❌ ENOENT Error                                 │
│                  {                                               │
│                    message: "ENOENT: no such file...",          │
│                    code: 'ENOENT'  ← Non-enumerable!            │
│                  }                                               │
│                           │                                      │
│                           └──────► Throw error                  │
└─────────────────────────────────────────────────────────────────┘
                           │
                           │ IPC Serialization (loses code!)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                         RENDERER PROCESS                         │
│                                                                  │
│  Error received:                                                 │
│  {                                                               │
│    message: "Error invoking remote method 'fs:stat': ...",      │
│    code: undefined  ← LOST!                                      │
│  }                                                               │
│         │                                                        │
│         └──────► isomorphic-git checks: err.code === 'ENOENT'  │
│                           │                                      │
│                           ▼                                      │
│                  ❌ FALSE (code is undefined)                    │
│                           │                                      │
│                           └──────► Throws unhandled error       │
│                                    💥 PROJECT CREATION FAILS    │
└─────────────────────────────────────────────────────────────────┘
```

## After the Fix ✅

```
┌─────────────────────────────────────────────────────────────────┐
│                         RENDERER PROCESS                         │
│                                                                  │
│  ElectronFSAdapter.stat('/projects/untitled')                   │
│         │                                                        │
│         └──────► IPC Call: fs:stat                              │
└─────────────────────────────────────────────────────────────────┘
                           │
                           │ IPC Channel
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                          MAIN PROCESS                            │
│                                                                  │
│  IPC Handler receives: '/projects/untitled'                     │
│         │                                                        │
│         └──────► fs.stat('/home/user/shakespeare/projects/...')│
│                           │                                      │
│                           ▼                                      │
│                  ❌ ENOENT Error                                 │
│                  {                                               │
│                    message: "ENOENT: no such file...",          │
│                    code: 'ENOENT'                                │
│                  }                                               │
│                           │                                      │
│                           └──────► Catch & Re-throw             │
│                                                                  │
│  ✅ FIX #1: Make code enumerable                                │
│  Object.defineProperty(err, 'code', {                           │
│    value: error.code,                                           │
│    enumerable: true  ← Survives IPC!                            │
│  })                                                              │
└─────────────────────────────────────────────────────────────────┘
                           │
                           │ IPC Serialization (preserves code!)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                         RENDERER PROCESS                         │
│                                                                  │
│  Error received:                                                 │
│  {                                                               │
│    message: "Error invoking remote method 'fs:stat': ...",      │
│    code: 'ENOENT'  ← PRESERVED! ✅                               │
│  }                                                               │
│         │                                                        │
│         └──────► ✅ FIX #2: unwrapElectronError()               │
│                           │                                      │
│                           ▼                                      │
│                  Extract code from error                         │
│                  Create new error with code property             │
│                           │                                      │
│                           └──────► Return to caller             │
│                                                                  │
│  isomorphic-git checks: err.code === 'ENOENT'                   │
│                           │                                      │
│                           ▼                                      │
│                  ✅ TRUE (code preserved!)                       │
│                           │                                      │
│                           └──────► Returns false                │
│                                    ✅ PROJECT CREATION SUCCEEDS │
└─────────────────────────────────────────────────────────────────┘
```

## Key Points

1. **Problem**: Error `code` property is non-enumerable by default and gets lost during IPC serialization

2. **Fix #1 (Main Process)**: Use `Object.defineProperty()` with `enumerable: true` to make the code property survive IPC

3. **Fix #2 (Renderer Process)**: Unwrap Electron's error wrapping and extract the code property (or parse from message as fallback)

4. **Result**: isomorphic-git's `FileSystem.exists()` method can properly detect ENOENT errors and return `false` instead of throwing
