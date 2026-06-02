import os
import shlex

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


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
    ]
    env = {}
    for key in keys:
        value = os.environ.get(key)
        if value:
            env[key] = value
    return env


class LightCCCoderAgent(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "light-cc-coder"

    async def install(self, environment: BaseEnvironment) -> None:
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
  version="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk '/linux-x64.tar.xz$/ {print $2; exit}' | sed 's#node-##; s#-linux-x64.tar.xz##')"
  archive="node-${version}-linux-x64.tar.xz"
  curl -fL "https://nodejs.org/dist/latest-v22.x/${archive}" -o "/tmp/${archive}"
  rm -rf /opt/lightcc-node
  mkdir -p /opt/lightcc-node
  tar -xJf "/tmp/${archive}" -C /opt/lightcc-node --strip-components=1
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

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        max_steps = os.environ.get("LIGHT_CC_TBENCH_MAX_STEPS", "120")
        permission_mode = os.environ.get("LIGHT_CC_TBENCH_PERMISSION_MODE", "danger-full-access")
        os_sandbox = os.environ.get("LIGHT_CC_TBENCH_OS_SANDBOX", "off")
        sandbox_settings = os.environ.get("LIGHT_CC_TBENCH_SANDBOX_SETTINGS")
        env_file = os.environ.get("LIGHT_CC_TBENCH_ENV_FILE")
        env = _agent_env()
        env_setup = ""
        if env_file:
            env_setup = f"set -a && . {shlex.quote(env_file)} && set +a && "
        sandbox_args = f" --os-sandbox {shlex.quote(os_sandbox)}"
        if sandbox_settings:
            sandbox_args += f" --sandbox-settings {shlex.quote(sandbox_settings)}"
        command = (
            "mkdir -p /logs/agent && "
            f"{env_setup}"
            f"lightcc -p {shlex.quote(instruction)} "
            f"--permission-mode {shlex.quote(permission_mode)} "
            f"--max-steps {shlex.quote(max_steps)} "
            "--artifact-dir /logs/agent "
            "--transcript /logs/agent/transcript.jsonl "
            "--quiet"
            f"{sandbox_args}"
        )
        await self.exec_as_agent(environment, command=command, env=env)

    def populate_context_post_run(self, context: AgentContext) -> None:
        return None
