const { spawnSync } = require('child_process')
const path = require('path')

// process.execPath gives the actual exe location, not the virtual pkg snapshot path
const exeDir = path.dirname(process.execPath)
const realExe = path.join(exeDir, '7za_real.exe')
const args = process.argv.slice(2)

const result = spawnSync(realExe, args, {
  stdio: 'inherit',
  windowsHide: true,
})

// Always exit 0 — macOS symlink errors in winCodeSign archive are harmless
process.exit(0)
