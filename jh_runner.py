#!/usr/bin/env python3
"""
JupyterHub Remote Runner
Запускает ноутбуки и скрипты на удалённом JupyterHub через REST API

УСТАНОВКА:
    pip install requests websocket-client

ЗАПУСК:
    python jh_runner.py --status                      # проверить подключение
    python jh_runner.py --list                        # список файлов
    python jh_runner.py --upload vault_bot.py         # загрузить файл
    python jh_runner.py --upload-all                  # загрузить все AI файлы
    python jh_runner.py --run vault_bot.py            # запустить скрипт
    python jh_runner.py --notebook my_nb.ipynb        # запустить ноутбук
    python jh_runner.py --exec "print(1+1)"           # выполнить код
    python jh_runner.py --kernels                     # список ядер
    python jh_runner.py --download result.txt         # скачать файл
"""

# ══════════════════════════════════════════════
#  НАСТРОЙКИ — измените эти 3 строки
# ══════════════════════════════════════════════
from config import JH_URL, JH_TOKEN, LOCAL_AI_FOLDER, MY_KERNEL_ID
# ══════════════════════════════════════════════

import json, time, base64, argparse, sys, threading, queue
from pathlib import Path
import requests
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


class JupyterClient:
    def __init__(self, base_url: str, token: str):
        self.base    = base_url.rstrip("/")
        self.token   = token
        self.headers = {
            "Authorization": f"Token {token}",
            "Content-Type":  "application/json",
        }

    def auto_detect_auth(self):
        """Автоматически определяет рабочий вариант авторизации."""
        self.check_status()

    def _url(self, path: str) -> str:
        return f"{self.base}/api/{path.lstrip('/')}"

    def get(self, path: str) -> dict:
        r = requests.get(self._url(path), headers=self.headers,
                        verify=False, timeout=30)
        r.raise_for_status()
        return r.json()

    def post(self, path: str, data: dict = None) -> dict:
        r = requests.post(self._url(path), headers=self.headers,
                          json=data or {}, verify=False, timeout=30)
        r.raise_for_status()
        return r.json() if r.content else {}

    def put(self, path: str, data: dict = None):
        r = requests.put(self._url(path), headers=self.headers,
                         json=data or {}, verify=False, timeout=60)
        r.raise_for_status()
        return r

    def delete(self, path: str):
        r = requests.delete(self._url(path), headers=self.headers,
                            verify=False, timeout=30)
        r.raise_for_status()

    # ── Статус ──
    def check_status(self) -> bool:
        """Перебирает все варианты авторизации и URL."""
        import requests as req

        base = self.base

        # Варианты заголовков авторизации
        auth_variants = [
            ("Token",  f"Token {self.token}"),
            ("Bearer", f"Bearer {self.token}"),
            ("token param", None),  # токен как параметр
        ]

        # Варианты URL (JupyterHub может быть за разными префиксами)
        url_variants = [
            f"{base}/api/kernels",
            f"{base}/api/status",
            f"{base}/api/kernelspecs",
        ]

        print("Перебираю варианты авторизации...\n")

        for auth_name, auth_value in auth_variants:
            for url in url_variants:
                try:
                    if auth_value:
                        headers = {"Authorization": auth_value}
                        r = req.get(url, headers=headers, verify=False, timeout=10)
                    else:
                        # Токен как параметр
                        r = req.get(url, params={"token": self.token},
                                   verify=False, timeout=10)

                    if r.status_code == 200:
                        print(f"✅ Работает!")
                        print(f"   Auth:     {auth_name}")
                        print(f"   URL:      {url}")
                        print(f"   Response: {r.text[:100]}")
                        # Обновляем заголовок на рабочий
                        if auth_value:
                            self.headers["Authorization"] = auth_value
                        return True
                    else:
                        print(f"   ❌ {r.status_code} | {auth_name} | {url.split('/api/')[-1]}")
                except Exception as e:
                    print(f"   💥 Error | {auth_name} | {url.split('/api/')[-1]}: {e}")

        print("❌ Ни один вариант не сработал")
        print("💡 Попробуйте получить токен иначе:")
        print("   В Jupyter Terminal:")
        print("   jupyter server list")
        print("   или: cat ~/.local/share/jupyter/runtime/jpserver-*.json")
        return False

    # ── Файлы ──
    def list_files(self, path: str = "") -> list:
        data = self.get(f"contents/{path}")
        return data.get("content", [])

    def upload_file(self, local_path: str, remote_name: str = None) -> str:
        local  = Path(local_path)
        remote = remote_name or local.name

        with open(local_path, "rb") as f:
            raw = f.read()

        if local.suffix == ".ipynb":
            fmt, ftype = "json",   "notebook"
            content    = json.loads(raw.decode("utf-8"))
        elif local.suffix in {".png", ".jpg", ".jpeg", ".pdf", ".gif"}:
            fmt, ftype = "base64", "file"
            content    = base64.b64encode(raw).decode("ascii")
        else:
            fmt, ftype = "text",   "file"
            try:
                content = raw.decode("utf-8")
            except UnicodeDecodeError:
                fmt     = "base64"
                content = base64.b64encode(raw).decode("ascii")

        self.put(f"contents/{remote}", {
            "name": local.name, "path": remote,
            "type": ftype, "format": fmt, "content": content,
        })
        size_kb = len(raw) // 1024
        print(f"  ✅ {remote} ({size_kb} КБ)")
        return remote

    def download_file(self, remote_path: str, local_path: str = None) -> str:
        data       = self.get(f"contents/{remote_path}")
        local_path = local_path or Path(remote_path).name
        content    = data.get("content", "")

        if data.get("format") == "base64":
            Path(local_path).write_bytes(base64.b64decode(content))
        elif isinstance(content, dict):
            Path(local_path).write_text(json.dumps(content, indent=2), encoding="utf-8")
        else:
            Path(local_path).write_text(str(content), encoding="utf-8")

        print(f"  ✅ Скачан: {local_path}")
        return local_path

    # ── Ядра ──
    def list_kernels(self) -> list:
        return self.get("kernels")

    def create_kernel(self, name: str = "python3") -> str:
        data = self.post("kernels", {"name": name})
        kid  = data["id"]
        print(f"  🟢 Ядро создано: {kid[:16]}... ({name})")
        return kid

    def delete_kernel(self, kernel_id: str):
        try:
            self.delete(f"kernels/{kernel_id}")
            print(f"  🔴 Ядро остановлено: {kernel_id[:16]}...")
        except Exception:
            pass

    # ── Выполнение кода через WebSocket ──
    def execute_code(self, code: str, kernel_id: str = None,
                     timeout: int = 300, verbose: bool = True) -> dict:
        # Определяем какое ядро использовать
        own_kernel = False
        if kernel_id is None:
            if MY_KERNEL_ID:
                kernel_id = MY_KERNEL_ID
                print(f"  ♻️  mykernel: {kernel_id[:16]}...")
            else:
                kernel_id  = self.create_kernel()
                own_kernel = True

        outputs = []
        try:
            try:
                import websocket
                outputs = self._ws_execute(code, kernel_id, timeout, verbose)
                if (outputs and outputs[0].get("type") == "error" and
                        "closed" in outputs[0].get("text", "").lower()):
                    print("  ⚠️  WS недоступен, пробую HTTP Execute API...")
                    outputs = self._http_execute(code, kernel_id, timeout, verbose)
            except ImportError:
                print("  ⚠️  websocket-client не установлен, использую HTTP API...")
                outputs = self._http_execute(code, kernel_id, timeout, verbose)
        finally:
            # Не удаляем MY_KERNEL_ID — это постоянное ядро пользователя
            if own_kernel:
                self.delete_kernel(kernel_id)

        return {"outputs": outputs, "kernel_id": kernel_id}

    def _http_execute(self, code: str, kernel_id: str,
                      timeout: int, verbose: bool) -> list:
        """
        Fallback: выполняет код через Jupyter Execute HTTP API.
        Работает когда WebSocket заблокирован прокси/файрволом.
        """
        import uuid

        msg_id = str(uuid.uuid4())
        # Jupyter Server 2.x поддерживает /api/kernels/{id}/execute
        try:
            resp = self.post(f"kernels/{kernel_id}/execute", {
                "code": code,
                "silent": False,
            })
            outputs = []
            for out in resp.get("outputs", []):
                otype = out.get("output_type", "")
                if otype == "stream":
                    text = out.get("text", "")
                    outputs.append({"type": "stream", "text": text})
                    if verbose: print(text, end="", flush=True)
                elif otype in ("execute_result", "display_data"):
                    text = out.get("data", {}).get("text/plain", "")
                    outputs.append({"type": "result", "text": text})
                    if verbose: print(text)
                elif otype == "error":
                    outputs.append({"type": "error",
                                   "ename": out.get("ename",""),
                                   "evalue": out.get("evalue","")})
                    if verbose: print(f"❌ {out.get('ename')}: {out.get('evalue')}")
            return outputs
        except Exception as e:
            # Последний fallback — nbconvert execute через сессию
            print(f"  ℹ️  HTTP Execute недоступен ({e})")
            print(f"  📋 Код сохранён для ручного запуска в JupyterHub")
            # Сохраняем код как .py файл на сервере
            try:
                self.put("contents/_runner_tmp.py", {
                    "name": "_runner_tmp.py",
                    "path": "_runner_tmp.py",
                    "type": "file",
                    "format": "text",
                    "content": code,
                })
                print(f"  📄 Файл загружен как _runner_tmp.py — запустите в терминале JH")
            except Exception:
                pass
            return [{"type": "info", "text": f"HTTP fallback failed: {e}"}]

    def test_websocket(self, kernel_id: str) -> dict:
        """Диагностика WebSocket подключения."""
        import websocket as wslib

        ws_base = (self.base
                   .replace("https://", "wss://")
                   .replace("http://",  "ws://"))
        ws_url = f"{ws_base}/api/kernels/{kernel_id}/channels"
        print(f"  WS URL: {ws_url}")

        results = {"connected": False, "messages": [], "error": None}
        done    = threading.Event()

        def on_open(ws):
            print("  ✅ on_open вызван!")
            results["connected"] = True

        def on_message(ws, msg):
            print(f"  📨 Сообщение: {msg[:100]}")
            results["messages"].append(msg[:200])

        def on_error(ws, err):
            print(f"  ❌ on_error: {err}")
            results["error"] = str(err)
            done.set()

        def on_close(ws, code, msg):
            print(f"  🔴 on_close: code={code} msg={msg}")
            done.set()

        ws = wslib.WebSocketApp(
            ws_url,
            header=[f"Authorization: Token {self.token}"],
            on_open=on_open,
            on_message=on_message,
            on_error=on_error,
            on_close=on_close,
        )
        t = threading.Thread(target=lambda: ws.run_forever(
            sslopt={"cert_reqs": 0}))
        t.daemon = True
        t.start()
        done.wait(timeout=10)
        ws.close()
        return results

    def _ws_execute(self, code: str, kernel_id: str,
                    timeout: int, verbose: bool) -> list:
        import websocket

        ws_base = (self.base
                   .replace("https://", "wss://")
                   .replace("http://",  "ws://"))
        ws_url  = f"{ws_base}/api/kernels/{kernel_id}/channels"

        msg_id  = f"msg_{int(time.time()*1000)}"
        outputs = []
        done_q  = queue.Queue()

        def on_message(ws, raw):
            msg      = json.loads(raw)
            parent   = msg.get("parent_header", {}).get("msg_id", "")
            msg_type = msg.get("msg_type", "")
            content  = msg.get("content", {})

            if parent != msg_id:
                return

            if msg_type == "stream":
                text = content.get("text", "")
                outputs.append({"type": "stream", "text": text})
                if verbose:
                    print(text, end="", flush=True)

            elif msg_type == "execute_result":
                text = content.get("data", {}).get("text/plain", "")
                outputs.append({"type": "result", "text": text})
                if verbose:
                    print(text)

            elif msg_type == "display_data":
                text = content.get("data", {}).get("text/plain", "[display]")
                outputs.append({"type": "display", "text": text})

            elif msg_type == "error":
                ename  = content.get("ename", "Error")
                evalue = content.get("evalue", "")
                tb     = "\n".join(content.get("traceback", []))
                outputs.append({"type": "error", "ename": ename,
                                "evalue": evalue, "traceback": tb})
                if verbose:
                    print(f"\n❌ {ename}: {evalue}")

            elif msg_type == "status":
                if content.get("execution_state") == "idle":
                    done_q.put("done")

        def on_error(ws, error):
            outputs.append({"type": "error", "text": str(error)})
            done_q.put("error")

        connected_q = queue.Queue()

        def on_open(ws):
            connected_q.put("open")

        def on_close(ws, code, msg):
            if done_q.empty():
                done_q.put("closed")

        ws = websocket.WebSocketApp(
            ws_url,
            header=[f"Authorization: Token {self.token}"],
            on_open=on_open,
            on_message=on_message,
            on_error=on_error,
            on_close=on_close,
        )

        t = threading.Thread(target=lambda: ws.run_forever(
            ping_interval=20,
            ping_timeout=10,
            sslopt={"cert_reqs": 0}
        ))
        t.daemon = True
        t.start()

        # Ждём реального подключения (не просто sleep)
        try:
            connected_q.get(timeout=15)
            print("  🔗 WebSocket подключён")
        except queue.Empty:
            ws.close()
            return [{"type": "error", "text": "WebSocket не подключился за 15с — проверьте токен и URL"}]

        time.sleep(0.3)  # небольшая пауза после on_open

        # Отправляем execute_request
        try:
            ws.send(json.dumps({
                "header": {
                    "msg_id":   msg_id,
                    "msg_type": "execute_request",
                    "version":  "5.3",
                    "session":  msg_id,
                    "username": "",
                    "date":     "",
                },
                "parent_header": {},
                "metadata":      {},
                "content": {
                    "code":             code,
                    "silent":           False,
                    "store_history":    True,
                    "user_expressions": {},
                    "allow_stdin":      False,
                },
                "channel": "shell",
            }))
        except Exception as send_err:
            print(f"  ❌ Ошибка отправки: {send_err}")
            ws.close()
            return [{"type": "error", "text": str(send_err)}]

        try:
            done_q.get(timeout=timeout)
        except queue.Empty:
            outputs.append({"type": "error", "text": f"Timeout ({timeout}s)"})
            print(f"\n⏰ Таймаут ({timeout}с)")

        ws.close()
        return outputs

    # ── Запуск ноутбука ──
    def run_notebook(self, notebook_path: str, timeout: int = 600,
                     kernel_id: str = None) -> dict:
        print(f"📓 Запускаю ноутбук: {notebook_path}")
        nb_data    = self.get(f"contents/{notebook_path}")
        nb         = nb_data.get("content", {})
        cells      = nb.get("cells", [])
        code_cells = [c for c in cells if c["cell_type"] == "code"]
        print(f"  Ячеек с кодом: {len(code_cells)}\n")

        # Используем переданное ядро или MY_KERNEL_ID или создаём новое
        own_kernel = False
        if kernel_id:
            print(f"  ♻️  Использую ядро: {kernel_id[:16]}...")
        elif MY_KERNEL_ID:
            kernel_id = MY_KERNEL_ID
            print(f"  ♻️  Использую mykernel: {kernel_id[:16]}...")
        else:
            kernel_id  = self.create_kernel()
            own_kernel = True

        results = []
        try:
            for i, cell in enumerate(code_cells, 1):
                source = "".join(cell.get("source", []))
                if not source.strip():
                    continue
                print(f"\n{'─'*50}")
                print(f"  Ячейка {i}/{len(code_cells)}")
                print(f"{'─'*50}")
                result = self.execute_code(source, kernel_id=kernel_id,
                                           timeout=timeout)
                results.append(result)
                has_error = any(o["type"] == "error"
                                for o in result.get("outputs", []))
                if has_error:
                    print(f"\n❌ Ошибка в ячейке {i} — остановка")
                    return {"results": results, "status": "error", "stopped_at": i}
        finally:
            if own_kernel:
                self.delete_kernel(kernel_id)
            else:
                print(f"  ♻️  Ядро сохранено (не удаляем)")

        print(f"\n{'='*50}")
        print(f"✅ Ноутбук выполнен: {len(results)} ячеек")
        return {"results": results, "status": "ok"}

    # ── Запуск скрипта ──
    def run_script(self, script_path: str, timeout: int = 300,
                   kernel_id: str = None) -> dict:
        local = Path(script_path)
        print(f"🐍 Запускаю: {local.name}\n")

        if local.exists():
            code = local.read_text(encoding="utf-8")
            try:
                self.upload_file(str(local))
            except Exception:
                pass
        else:
            data = self.get(f"contents/{script_path}")
            code = data.get("content", "")

        # Используем MY_KERNEL_ID если не указан явно
        kid = kernel_id or MY_KERNEL_ID or None
        if kid:
            print(f"  ♻️  Ядро: {kid[:16]}...")
        print(f"  Код: {len(code)} символов\n")
        return self.execute_code(code, kernel_id=kid, timeout=timeout)


# ──────────────────────────────────────────────
#  CLI
# ──────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="JupyterHub Remote Runner")
    parser.add_argument("--status",     action="store_true",   help="Проверить подключение")
    parser.add_argument("--ws-test",    action="store_true",   help="Диагностика WebSocket")
    parser.add_argument("--list",       action="store_true",   help="Список файлов")
    parser.add_argument("--list-path",  default="",            help="Путь для --list")
    parser.add_argument("--kernels",    action="store_true",   help="Список ядер")
    parser.add_argument("--upload",     metavar="FILE",        help="Загрузить файл")
    parser.add_argument("--upload-all", action="store_true",   help="Загрузить все .py файлы из AI папки")
    parser.add_argument("--download",   metavar="FILE",        help="Скачать файл с сервера")
    parser.add_argument("--run",        metavar="SCRIPT",      help="Запустить .py скрипт")
    parser.add_argument("--notebook",   metavar="NOTEBOOK",    help="Запустить .ipynb ноутбук")
    parser.add_argument("--exec",       metavar="CODE",        help="Выполнить строку кода")
    parser.add_argument("--timeout",    type=int, default=300, help="Таймаут (сек, по умолчанию 300)")
    parser.add_argument("--kernel",     default=None,          help="ID ядра (по умолчанию MY_KERNEL_ID)")
    parser.add_argument("--token",      default=JH_TOKEN,      help="Jupyter токен")
    parser.add_argument("--url",        default=JH_URL,        help="JupyterHub URL")
    args = parser.parse_args()

    if args.token == "YOUR_JUPYTER_TOKEN":
        print("❌ Укажите JH_TOKEN в настройках скрипта (или через --token)")
        sys.exit(1)

    client = JupyterClient(args.url, args.token)
    print(f"🔌 {args.url}\n")

    if args.ws_test:
        print("Диагностика WebSocket...")
        if not MY_KERNEL_ID:
            print("❌ Укажите MY_KERNEL_ID в настройках скрипта")
        else:
            kid = args.kernel or MY_KERNEL_ID
            print(f"   Ядро: {kid[:16]}...")
            result = client.test_websocket(kid)
            print("connected=" + str(result["connected"]))
            if result["error"]:
                print("Ошибка: " + str(result["error"]))
            if not result["connected"]:
                print("WS недоступен — возможно заблокирован прокси")
                print("Используйте HTTP fallback (автоматически)")

    elif args.status:
        # Используем существующее ядро для проверки доступа
        import requests as req
        print("Проверяю доступ к API...\n")
        auth_variants = [
            ("Token",  {"Authorization": f"Token {args.token}"}),
            ("Bearer", {"Authorization": f"Bearer {args.token}"}),
        ]
        url_variants = [
            f"{args.url}/api/contents",
            f"{args.url}/api/kernelspecs",
            f"{args.url}/api/kernels/{MY_KERNEL_ID}",
        ]
        found = False
        for auth_name, headers in auth_variants:
            for url in url_variants:
                try:
                    r = req.get(url, headers=headers, verify=False, timeout=10)
                    status = r.status_code
                    mark   = "✅" if status == 200 else "❌"
                    print(f"{mark} [{status}] {auth_name:6} | {url.split('/api/')[-1]}")
                    if status == 200 and not found:
                        found = True
                        client.headers["Authorization"] = headers["Authorization"]
                        print(f"\n✅ Рабочий вариант: {auth_name}")
                        print(f"   Обновите в скрипте: Authorization: {headers['Authorization'][:30]}...")
                except Exception as e:
                    print(f"💥 Error | {auth_name} | {url.split('/api/')[-1]}: {e}")
        if not found:
            print("\n❌ Нет рабочего варианта авторизации")
            print("\nПопробуйте получить токен через Jupyter Terminal:")
            print("  jupyter server list")
        client.check_status()

    elif args.list:
        files = client.list_files(args.list_path)
        path_label = args.list_path or "/"
        print(f"📂 {path_label} ({len(files)} объектов):\n")
        for f in sorted(files, key=lambda x: (x["type"] != "directory", x["name"])):
            icon     = "📁" if f["type"] == "directory" else "📄"
            size     = f.get("size") or 0
            size_str = f"{size//1024}КБ" if size > 1024 else f"{size}Б" if size else ""
            modified = f.get("last_modified", "")[:10]
            print(f"  {icon} {f['name']:<45} {size_str:<8} {modified}")

    elif args.kernels:
        kernels = client.list_kernels()
        if not kernels:
            print("Нет активных ядер")
        else:
            print(f"Активных ядер: {len(kernels)}\n")
            for k in kernels:
                print(f"  🟢 {k['id']}")
                print(f"     Имя: {k.get('name','?')}  "
                      f"Статус: {k.get('execution_state','?')}")

    elif args.upload:
        print(f"📤 Загружаю: {args.upload}")
        client.upload_file(args.upload)

    elif args.upload_all:
        folder  = Path(LOCAL_AI_FOLDER)
        scripts = sorted(folder.glob("*.py")) + sorted(folder.glob("*.ipynb"))
        print(f"📤 Загружаю {len(scripts)} файлов из {folder}:\n")
        ok, fail = 0, 0
        for f in scripts:
            try:
                client.upload_file(str(f))
                ok += 1
            except Exception as e:
                print(f"  ❌ {f.name}: {e}")
                fail += 1
        print(f"\n  Загружено: {ok}, ошибок: {fail}")

    elif args.download:
        client.download_file(args.download)

    elif args.run:
        result  = client.run_script(args.run, timeout=args.timeout, kernel_id=args.kernel)
        errors  = [o for o in result.get("outputs", []) if o["type"] == "error"]
        print(f"\n{'✅ Успешно' if not errors else f'❌ Ошибок: {len(errors)}'}")

    elif args.notebook:
        result = client.run_notebook(args.notebook, timeout=args.timeout, kernel_id=args.kernel)

    elif args.exec:
        print("▶ Выполняю код...\n")
        result = client.execute_code(args.exec, kernel_id=args.kernel, timeout=args.timeout)
        errors = [o for o in result.get("outputs", []) if o["type"] == "error"]
        print(f"\n{'✅ OK' if not errors else f'❌ Ошибок: {len(errors)}'}")

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
