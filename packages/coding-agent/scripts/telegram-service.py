# starts the external telegram mcp server with credentials from a private file.
import os
from pathlib import Path
from runpy import run_module

from dotenv import load_dotenv

os.umask(0o077)
config = Path(os.environ.get("PI_TELEGRAM_ENV", str(Path.home() / ".config/telegram-mcp/account.env")))
proxy = {key: value for key, value in os.environ.items() if key.startswith("TELEGRAM_PROXY_")}
load_dotenv(config, override=False)
for key in list(os.environ):
    if key.startswith("TELEGRAM_PROXY_"):
        del os.environ[key]
os.environ.update(proxy)
os.environ["PYTHON_DOTENV_DISABLED"] = "1"
data = Path.home() / ".local/share/telegram-mcp"
data.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chdir(data)

run_module("telegram_mcp.runner", run_name="__main__")
