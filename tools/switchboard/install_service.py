"""Install the local relay as a macOS user service, independent of agent turns."""
import os
from pathlib import Path
import plistlib
import shutil
import shlex
import subprocess
import time

label="dev.zellij.switchboard"
root=Path(__file__).resolve().parent
agents=Path.home()/"Library/LaunchAgents"
logs=Path.home()/"Library/Logs"
agents.mkdir(parents=True,exist_ok=True)
logs.mkdir(parents=True,exist_ok=True)
uv=shutil.which("uv")
if not uv:
    raise SystemExit("uv must be installed")
zellij=shutil.which("zellij")
program=[uv,"run","--script",str(root/"server.py")]
if zellij:
    # Native daemon mode keeps the upstream server independent of any terminal.
    startup=shlex.join([zellij,"web","--status","--timeout","2"])+" >/dev/null 2>&1 || "+shlex.join([zellij,"web","--daemonize"])
    program=["/bin/sh","-c",startup+"; exec "+shlex.join(program)]
target=agents/(label+".plist")
target.write_bytes(plistlib.dumps({
    "Label":label,
    "ProgramArguments":program,
    "WorkingDirectory":str(root),
    "RunAtLoad":True,
    "KeepAlive":True,
    "StandardOutPath":str(logs/"zellij-switchboard.log"),
    "StandardErrorPath":str(logs/"zellij-switchboard.log"),
    "EnvironmentVariables":{"PATH":f"{Path.home()}/.local/bin:{Path.home()}/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"},
}))
domain=f"gui/{os.getuid()}"
subprocess.run(["launchctl","bootout",domain+"/"+label],capture_output=True)
command=["launchctl","bootstrap",domain,str(target)]
result=subprocess.run(command,capture_output=True)
if result.returncode == 5:
    # launchd briefly retains the label after a successful bootout.
    time.sleep(0.5)
    result=subprocess.run(command,capture_output=True)
result.check_returncode()
print("Switchboard service installed: https://zellij.localhost (also http://127.0.0.1:8090)")
