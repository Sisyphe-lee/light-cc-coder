import os
import shlex
import base64
import json

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


READY_CODER_IDS = {"lightcc", "openhands", "aider", "opencode"}


def _agent_env() -> dict[str, str]:
    keys = [
        "LIGHT_CC_BASE_URL",
        "LIGHT_CC_MODEL",
        "LIGHT_CC_API_KEY_ENV",
        "LIGHT_CC_TBENCH_MAX_STEPS",
        "LIGHT_CC_TBENCH_PERMISSION_MODE",
        "LIGHT_CC_TBENCH_OS_SANDBOX",
        "LIGHT_CC_TBENCH_SANDBOX_SETTINGS",
        "LIGHT_CC_TBENCH_ENV_FILE",
        "LIGHT_CC_TBENCH_CODER_ID",
        "LIGHT_CC_TBENCH_CODER_STATUS",
        "LIGHT_CC_TBENCH_CODER_MODEL",
        "LIGHT_CC_TBENCH_PROVIDER_BASE_URL",
        "LIGHT_CC_TBENCH_CODER_DISPLAY_NAME",
        "LIGHT_CC_TBENCH_CODER_RUNTIME",
        "LIGHT_CC_TBENCH_CODER_RUN_STATUS",
        "LIGHT_CC_TBENCH_AGENT_PROFILE",
        "LIGHT_CC_TBENCH_WORKSPACE",
        "LIGHT_CC_TBENCH_ARTIFACT_DIR",
        "LIGHT_CC_TBENCH_PROMPT_FILE",
        "LIGHT_CC_TBENCH_TRANSCRIPT_PATH",
        "LIGHT_CC_TBENCH_PATCH_PATH",
        "LIGHT_CC_TBENCH_RESULT_PATH",
        "LIGHT_CC_TBENCH_EXTERNAL_INSTALL_MODE",
        "LIGHT_CC_TBENCH_EXTERNAL_BIN_DIR",
        "LIGHT_CC_TBENCH_EXTERNAL_RUN_TIMEOUT_SECONDS",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
    ]
    env = {}
    for key in keys:
        value = os.environ.get(key)
        if value:
            env[key] = value
    return env


def _truthy(value: str | None) -> bool:
    return bool(value and value.strip().lower() not in {"0", "false", "no"})


def _path_env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _source_env_file_command() -> str:
    env_file = os.environ.get("LIGHT_CC_TBENCH_ENV_FILE")
    if not env_file:
        return ""
    return f"set -a\n. {shlex.quote(env_file)}\nset +a\n"


def _restore_provider_env_command() -> str:
    return """
if [ -n "${LIGHT_CC_TBENCH_PROVIDER_BASE_URL:-}" ]; then
  export LIGHT_CC_BASE_URL="$LIGHT_CC_TBENCH_PROVIDER_BASE_URL"
fi
if [ -n "${LIGHT_CC_TBENCH_CODER_MODEL:-}" ]; then
  export LIGHT_CC_MODEL="$LIGHT_CC_TBENCH_CODER_MODEL"
fi
"""


def _external_executable(coder_id: str) -> str:
    if coder_id == "openhands":
        return "openhands"
    if coder_id == "aider":
        return "aider"
    if coder_id == "opencode":
        return "opencode"
    raise RuntimeError(f"Unsupported external coder: {coder_id}")


def _external_healthcheck_command(coder_id: str) -> str:
    executable = _external_executable(coder_id)
    if coder_id == "aider":
        return f"{executable} --version >/dev/null"
    return f"{executable} --help >/dev/null"


def _external_path_command() -> str:
    install_mode = os.environ.get("LIGHT_CC_TBENCH_EXTERNAL_INSTALL_MODE", "online")
    if install_mode != "mounted":
        return ""
    bin_dir = _path_env("LIGHT_CC_TBENCH_EXTERNAL_BIN_DIR", "/home/sjx/.local/bin")
    return f"export PATH={shlex.quote(bin_dir)}:$PATH\n"


def _write_prompt_command() -> str:
    artifact_dir = _path_env("LIGHT_CC_TBENCH_ARTIFACT_DIR", "/logs/agent")
    prompt_file = _path_env("LIGHT_CC_TBENCH_PROMPT_FILE", "/logs/agent/prompt.md")
    return f"""
node -e "const fs=require('fs'); const artifactDir={artifact_dir!r}; const promptFile={prompt_file!r}; fs.mkdirSync(artifactDir, {{recursive:true}}); fs.mkdirSync(require('path').dirname(promptFile), {{recursive:true}}); fs.writeFileSync(promptFile, Buffer.from(process.env.LIGHT_CC_TBENCH_INSTRUCTION_B64 || '', 'base64').toString('utf8'));"
"""


def _workspace_command() -> str:
    configured = _path_env("LIGHT_CC_TBENCH_WORKSPACE", "/workspace")
    return f"""
workspace={shlex.quote(configured)}
if [ ! -d "$workspace" ]; then
  if [ -d /workspace ]; then
    workspace=/workspace
  elif [ -d /app ]; then
    workspace=/app
  else
    workspace="$(pwd)"
  fi
fi
export LIGHT_CC_TBENCH_RESOLVED_WORKSPACE="$workspace"
cd "$workspace"
"""


def _context_task_id(context: AgentContext) -> str:
    for name in ("task_id", "task_name", "id"):
        value = getattr(context, name, None)
        if value:
            return str(value)
    return ""


def _wrapper_profile_command(executable: str, arg_count: int | None = None) -> str:
    artifact_dir = _path_env("LIGHT_CC_TBENCH_ARTIFACT_DIR", "/logs/agent")
    profile_path = f"{artifact_dir}/wrapper.profile.json"
    arg_count_json = "None" if arg_count is None else str(arg_count)
    return f"""
wrapper_ended_ms="$(date +%s%3N)"
wrapper_duration_ms=$((wrapper_ended_ms - wrapper_started_ms))
export LIGHT_CC_TBENCH_WRAPPER_EXIT_CODE="$status"
export LIGHT_CC_TBENCH_WRAPPER_DURATION_MS="$wrapper_duration_ms"
python3 - <<'PY'
import hashlib
import json
import os
from pathlib import Path

artifact_dir = Path({artifact_dir!r})
profile_path = Path({profile_path!r})
artifact_dir.mkdir(parents=True, exist_ok=True)

def env(name, default=""):
    return os.environ.get(name, default)

def artifact(kind, name):
    path = env(name)
    if not path:
        return None
    item = Path(path)
    if not item.exists():
        return None
    result = {{"kind": kind, "path": str(item)}}
    if item.is_file():
        data = item.read_bytes()
        result["bytes"] = len(data)
        result["sha256"] = hashlib.sha256(data).hexdigest()
    else:
        result["bytes"] = None
        result["sha256"] = None
    return result

api_key_name = env("LIGHT_CC_API_KEY_ENV", "OPENAI_API_KEY")
required = [api_key_name] if api_key_name else []
forwarded = sorted({{name for name in [
    "LIGHT_CC_BASE_URL",
    "LIGHT_CC_MODEL",
    "LIGHT_CC_API_KEY_ENV",
    "LIGHT_CC_TBENCH_CODER_MODEL",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "LLM_API_KEY",
    api_key_name,
] if name}})
present = [name for name in required if os.environ.get(name)]
missing = [name for name in required if name not in present]
artifacts = [
    artifact("prompt", "LIGHT_CC_TBENCH_PROMPT_FILE"),
    artifact("transcript", "LIGHT_CC_TBENCH_TRANSCRIPT_PATH"),
    artifact("patch", "LIGHT_CC_TBENCH_PATCH_PATH"),
    artifact("result", "LIGHT_CC_TBENCH_RESULT_PATH"),
]
profile_report = artifact("summary", "LIGHT_CC_TBENCH_PROFILE_REPORT_PATH")
if profile_report:
    artifacts.append(profile_report)
workspace = env("LIGHT_CC_TBENCH_RESOLVED_WORKSPACE") or env("LIGHT_CC_TBENCH_WORKSPACE")
if workspace:
    artifacts.append({{"kind": "workspace", "path": workspace, "bytes": None, "sha256": None}})
profile = {{
    "schemaVersion": 1,
    "generatedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z"),
    "wrapper": {{
        "id": env("LIGHT_CC_TBENCH_CODER_ID", "lightcc"),
        "displayName": env("LIGHT_CC_TBENCH_CODER_DISPLAY_NAME") or env("LIGHT_CC_TBENCH_CODER_ID", "lightcc"),
        "runtime": env("LIGHT_CC_TBENCH_CODER_RUNTIME", "installed-agent"),
    }},
    "run": {{
        "benchmark": "terminal-bench",
        "runId": env("LIGHT_CC_TBENCH_RUN_ID"),
        "itemId": env("LIGHT_CC_TBENCH_TASK_ID"),
    }},
    "command": {{
        "executablePath": {executable!r},
        "cwd": workspace,
    }},
    "artifacts": [item for item in artifacts if item],
    "environment": {{
        "requiredNames": required,
        "forwardedNames": forwarded,
        "presentNames": present,
        "missingNames": missing,
    }},
    "process": {{
        "exitCode": int(env("LIGHT_CC_TBENCH_WRAPPER_EXIT_CODE", "0")),
        "durationMs": int(env("LIGHT_CC_TBENCH_WRAPPER_DURATION_MS", "0")),
    }},
    "warnings": [],
}}
arg_count = {arg_count_json}
if arg_count is not None:
    profile["command"]["argCount"] = arg_count
profile_path.write_text(json.dumps(profile, indent=2) + "\\n", encoding="utf-8")
PY
"""


class LightCCCoderAgent(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return os.environ.get("LIGHT_CC_TBENCH_CODER_ID", "light-cc-coder")

    async def install(self, environment: BaseEnvironment) -> None:
        coder_id = os.environ.get("LIGHT_CC_TBENCH_CODER_ID", "lightcc")
        if coder_id not in READY_CODER_IDS:
            raise RuntimeError(f"Terminal-Bench installed-agent wrapper does not support coder: {coder_id}")
        if coder_id != "lightcc":
            await self._install_external_coder(environment, coder_id)
            return
        package_spec = os.environ.get("LIGHT_CC_TBENCH_NPM_SPEC", "light-cc-coder")
        node_dir = os.environ.get("LIGHT_CC_TBENCH_NODE_DIR")
        source_dir = package_spec.removeprefix("source:") if package_spec.startswith("source:") else None
        node_setup = (
            f"""
if [ ! -x {shlex.quote(node_dir)}/bin/node ]; then
  echo "LIGHT_CC_TBENCH_NODE_DIR does not contain bin/node: {shlex.quote(node_dir)}" >&2
  exit 1
fi
ln -sfn {shlex.quote(node_dir)}/bin/node /usr/local/bin/node
ln -sfn {shlex.quote(node_dir)}/bin/npm /usr/local/bin/npm
ln -sfn {shlex.quote(node_dir)}/bin/npx /usr/local/bin/npx
"""
            if node_dir
            else """
apt-get update
apt-get install -y ca-certificates curl git xz-utils
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -lt 20 ]; then
  version="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk '/linux-x64.tar.xz$/ {{print $2; exit}}' | sed 's#node-##; s#-linux-x64.tar.xz##')"
  archive="node-${{version}}-linux-x64.tar.xz"
  curl -fL "https://nodejs.org/dist/latest-v22.x/${{archive}}" -o "/tmp/${{archive}}"
  rm -rf /opt/lightcc-node
  mkdir -p /opt/lightcc-node
  tar -xJf "/tmp/${{archive}}" -C /opt/lightcc-node --strip-components=1
  ln -sfn /opt/lightcc-node/bin/node /usr/local/bin/node
  ln -sfn /opt/lightcc-node/bin/npm /usr/local/bin/npm
  ln -sfn /opt/lightcc-node/bin/npx /usr/local/bin/npx
fi
"""
        )
        package_setup = (
            f"""
if [ ! -f {shlex.quote(source_dir)}/dist/main.js ]; then
  echo "source package is missing dist/main.js: {shlex.quote(source_dir)}" >&2
  exit 1
fi
cat > /usr/local/bin/lightcc <<'LIGHTCC_WRAPPER'
#!/usr/bin/env bash
exec node {shlex.quote(source_dir)}/dist/main.js "$@"
LIGHTCC_WRAPPER
chmod +x /usr/local/bin/lightcc
"""
            if source_dir
            else f"npm install -g {shlex.quote(package_spec)}\n"
        )
        command = f"""
set -euo pipefail
{node_setup}
{package_setup}
lightcc --help >/dev/null
"""
        await self.exec_as_root(environment, command=command)

    async def _install_external_coder(self, environment: BaseEnvironment, coder_id: str) -> None:
        install_mode = os.environ.get("LIGHT_CC_TBENCH_EXTERNAL_INSTALL_MODE", "online")
        if install_mode == "mounted":
            executable = _external_executable(coder_id)
            healthcheck = _external_healthcheck_command(coder_id)
            command = f"""
set -euo pipefail
{_external_path_command()}
if ! command -v {shlex.quote(executable)} >/dev/null 2>&1; then
  echo "mounted external coder executable not found on PATH: {shlex.quote(executable)}" >&2
  echo "LIGHT_CC_TBENCH_EXTERNAL_BIN_DIR={shlex.quote(_path_env("LIGHT_CC_TBENCH_EXTERNAL_BIN_DIR", "/home/sjx/.local/bin"))}" >&2
  exit 1
fi
{healthcheck}
"""
            await self.exec_as_root(environment, command=command, env=_agent_env())
            return

        apt_packages = "ca-certificates curl git xz-utils"
        if coder_id in {"openhands", "aider"}:
            apt_packages = f"{apt_packages} python3 python3-pip python3-venv"
        node_setup = f"""
apt-get update
apt-get install -y {apt_packages}
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -lt 20 ]; then
  version="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk '/linux-x64.tar.xz$/ {{print $2; exit}}' | sed 's#node-##; s#-linux-x64.tar.xz##')"
  archive="node-${{version}}-linux-x64.tar.xz"
  curl -fL "https://nodejs.org/dist/latest-v22.x/${{archive}}" -o "/tmp/${{archive}}"
  rm -rf /opt/lightcc-node
  mkdir -p /opt/lightcc-node
  tar -xJf "/tmp/${{archive}}" -C /opt/lightcc-node --strip-components=1
  ln -sfn /opt/lightcc-node/bin/node /usr/local/bin/node
  ln -sfn /opt/lightcc-node/bin/npm /usr/local/bin/npm
  ln -sfn /opt/lightcc-node/bin/npx /usr/local/bin/npx
fi
"""
        if coder_id == "openhands":
            install = """
python3 -m pip install --break-system-packages -U uv || python3 -m pip install -U uv
uv tool install openhands
ln -sfn /root/.local/bin/openhands /usr/local/bin/openhands
openhands --help >/dev/null
"""
        elif coder_id == "aider":
            install = """
python3 -m pip install --break-system-packages -U pipx || python3 -m pip install -U pipx
python3 -m pipx install --force aider-chat
ln -sfn /root/.local/bin/aider /usr/local/bin/aider
aider --version >/dev/null
"""
        elif coder_id == "opencode":
            install = """
npm install -g opencode-ai
opencode --help >/dev/null
"""
        else:
            raise RuntimeError(f"Unsupported external coder: {coder_id}")
        await self.exec_as_root(environment, command=f"set -euo pipefail\n{node_setup}\n{install}", env=_agent_env())

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        coder_id = os.environ.get("LIGHT_CC_TBENCH_CODER_ID", "lightcc")
        if coder_id not in READY_CODER_IDS:
            raise RuntimeError(f"Terminal-Bench installed-agent wrapper does not support coder: {coder_id}")
        if coder_id != "lightcc":
            await self._run_external_coder(instruction, environment, context, coder_id)
            return
        max_steps = os.environ.get("LIGHT_CC_TBENCH_MAX_STEPS", "120")
        permission_mode = os.environ.get("LIGHT_CC_TBENCH_PERMISSION_MODE", "danger-full-access")
        os_sandbox = os.environ.get("LIGHT_CC_TBENCH_OS_SANDBOX", "off")
        sandbox_settings = os.environ.get("LIGHT_CC_TBENCH_SANDBOX_SETTINGS")
        env = _agent_env()
        env["LIGHT_CC_TBENCH_INSTRUCTION_B64"] = base64.b64encode(instruction.encode("utf-8")).decode("ascii")
        sandbox_args = f" --os-sandbox {shlex.quote(os_sandbox)}"
        if sandbox_settings:
            sandbox_args += f" --sandbox-settings {shlex.quote(sandbox_settings)}"
        prompt_file = _path_env("LIGHT_CC_TBENCH_PROMPT_FILE", "/logs/agent/prompt.md")
        transcript_path = _path_env("LIGHT_CC_TBENCH_TRANSCRIPT_PATH", "/logs/agent/transcript.jsonl")
        artifact_dir = _path_env("LIGHT_CC_TBENCH_ARTIFACT_DIR", "/logs/agent")
        patch_path = _path_env("LIGHT_CC_TBENCH_PATCH_PATH", "/logs/agent/patch.diff")
        profile_report_path = f"{artifact_dir}/profile.report.json"
        profile_arg = " --profile" if _truthy(os.environ.get("LIGHT_CC_TBENCH_AGENT_PROFILE")) else ""
        profile_command = (
            f"if [ -f {shlex.quote(transcript_path)} ]; then lightcc profile {shlex.quote(transcript_path)} --json --out {shlex.quote(profile_report_path)} || true; fi"
            if profile_arg
            else ":"
        )
        env["LIGHT_CC_TBENCH_TASK_ID"] = _context_task_id(context)
        env["LIGHT_CC_TBENCH_PROFILE_REPORT_PATH"] = profile_report_path
        command = (
            "set -u\n"
            'wrapper_started_ms="$(date +%s%3N)"\n'
            f"{_source_env_file_command()}"
            f"{_restore_provider_env_command()}"
            f"{_write_prompt_command()}"
            f"{_workspace_command()}"
            "set +e\n"
            f"lightcc --prompt-file {shlex.quote(prompt_file)} "
            f"--permission-mode {shlex.quote(permission_mode)} "
            f"--max-steps {shlex.quote(max_steps)} "
            f"--artifact-dir {shlex.quote(artifact_dir)} "
            f"--transcript {shlex.quote(transcript_path)} "
            "--quiet"
            f"{profile_arg}"
            f"{sandbox_args}"
            "\nstatus=$?\n"
            f"{profile_command}\n"
            f"git diff --binary --no-ext-diff HEAD > {shlex.quote(patch_path)} || true\n"
            f"{_wrapper_profile_command('lightcc', 12)}\n"
            "exit $status"
        )
        await self.exec_as_agent(environment, command=command, env=env)

    async def _run_external_coder(self, instruction: str, environment: BaseEnvironment, context: AgentContext, coder_id: str) -> None:
        env = _agent_env()
        env["LIGHT_CC_TBENCH_INSTRUCTION_B64"] = base64.b64encode(instruction.encode("utf-8")).decode("ascii")
        env["LIGHT_CC_TBENCH_TASK_ID"] = _context_task_id(context)
        workspace = _path_env("LIGHT_CC_TBENCH_WORKSPACE", "/workspace")
        artifact_dir = _path_env("LIGHT_CC_TBENCH_ARTIFACT_DIR", "/logs/agent")
        prompt_file = _path_env("LIGHT_CC_TBENCH_PROMPT_FILE", "/logs/agent/prompt.md")
        transcript_path = _path_env("LIGHT_CC_TBENCH_TRANSCRIPT_PATH", "/logs/agent/transcript.jsonl")
        patch_path = _path_env("LIGHT_CC_TBENCH_PATCH_PATH", "/logs/agent/patch.diff")
        result_path = _path_env("LIGHT_CC_TBENCH_RESULT_PATH", "/logs/agent/result.json")
        model = os.environ.get("LIGHT_CC_TBENCH_CODER_MODEL") or os.environ.get("LIGHT_CC_MODEL", "")
        base_url = os.environ.get("LIGHT_CC_BASE_URL", "")
        timeout_seconds = os.environ.get("LIGHT_CC_TBENCH_EXTERNAL_RUN_TIMEOUT_SECONDS", "1800")
        setup = f"""
set -u
wrapper_started_ms="$(date +%s%3N)"
{_source_env_file_command()}
{_restore_provider_env_command()}
{_external_path_command()}
{_write_prompt_command()}
{_workspace_command()}
mkdir -p {shlex.quote(artifact_dir)}
api_key="$(printenv "$LIGHT_CC_API_KEY_ENV" 2>/dev/null || true)"
export DEEPSEEK_API_KEY="$api_key"
export OPENAI_API_KEY="$api_key"
export AIDER_OPENAI_API_BASE={shlex.quote(base_url)}
export DEEPSEEK_API_BASE={shlex.quote(base_url)}
export HOME={shlex.quote(artifact_dir)}/home
export XDG_CONFIG_HOME={shlex.quote(artifact_dir)}/xdg-config
export XDG_CACHE_HOME={shlex.quote(artifact_dir)}/xdg-cache
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
set +e
"""
        if coder_id == "openhands":
            run_command = (
                f"LLM_API_KEY=\"$api_key\" LLM_MODEL={shlex.quote(f'openai/{model}')} "
                f"LLM_BASE_URL={shlex.quote(base_url)} "
                f"openhands --headless --json --file {shlex.quote(prompt_file)} --override-with-envs "
                f"> {shlex.quote(transcript_path)}"
            )
        elif coder_id == "aider":
            run_command = (
                "AIDER_ANALYTICS_DISABLE=true "
                f"AIDER_LLM_HISTORY_FILE={shlex.quote(transcript_path)} "
                f"aider --yes-always --no-pretty --no-stream --no-auto-commits --no-check-update "
                f"--model {shlex.quote(f'deepseek/{model}')} "
                f"--openai-api-base {shlex.quote(base_url)} "
                f"--message-file {shlex.quote(prompt_file)}"
            )
        elif coder_id == "opencode":
            run_command = (
                "export OPENCODE_CONFIG_CONTENT=\"$(node - <<'NODE'\n"
                f"const model = {json.dumps(model)};\n"
                f"const baseURL = {json.dumps(base_url)};\n"
                "console.log(JSON.stringify({\"$schema\":\"https://opencode.ai/config.json\",model:`deepseek/${model}`,small_model:`deepseek/${model}`,provider:{deepseek:{options:{apiKey:process.env.DEEPSEEK_API_KEY || \"\",baseURL}}},enabled_providers:[\"deepseek\"]}));\n"
                "NODE\n"
                ")\"\n"
                "OPENCODE_DISABLE_AUTOUPDATE=true "
                f"opencode run --format json --model {shlex.quote(f'deepseek/{model}')} "
                f'--dir "$workspace" --file {shlex.quote(prompt_file)} --dangerously-skip-permissions '
                f"{shlex.quote('Execute the benchmark instructions from the attached prompt file.')} "
                f"> {shlex.quote(transcript_path)}"
            )
        else:
            raise RuntimeError(f"Unsupported external coder: {coder_id}")
        run_command = f"timeout --foreground {shlex.quote(timeout_seconds)} bash -c {shlex.quote(run_command)}"
        arg_count = {"openhands": 5, "aider": 10, "opencode": 8}.get(coder_id)
        command = f"""
{setup}
{run_command}
status=$?
git diff --binary --no-ext-diff HEAD > {shlex.quote(patch_path)} || true
python3 - <<'PY'
import json
from pathlib import Path
Path({result_path!r}).write_text(json.dumps({{"status": "completed"}}, indent=2) + "\\n", encoding="utf-8")
PY
{_wrapper_profile_command(coder_id, arg_count)}
exit $status
"""
        await self.exec_as_agent(environment, command=command, env=env)

    def populate_context_post_run(self, context: AgentContext) -> None:
        return None
