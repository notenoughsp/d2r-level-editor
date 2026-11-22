// D2R Level Editor launcher: starts the editor server with the bundled Python runtime and opens
// the editor in its own app window (Edge or Chrome --app). Closing the window stops the server.
//
// Folder layout next to the exe:
//   runtime\python.exe   bundled Python (falls back to python.exe on PATH for a dev checkout)
//   app\server.py        editor program
//   data\                project, editor state, asset cache, settings.json, server.log
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>

#include <string>
#include <vector>

namespace {

const wchar_t* kTitle = L"D2R Level Editor";

std::wstring g_dir;      // folder of the exe
std::wstring g_data;     // data folder
HWND g_splash = nullptr;

// Launcher messages follow the Windows display language (German, otherwise English).
const wchar_t* Tr(const wchar_t* de, const wchar_t* en) {
  static const bool german = PRIMARYLANGID(GetUserDefaultUILanguage()) == LANG_GERMAN;
  return german ? de : en;
}

std::wstring ExeDir() {
  wchar_t buf[MAX_PATH * 4];
  DWORD n = GetModuleFileNameW(nullptr, buf, ARRAYSIZE(buf));
  std::wstring p(buf, n);
  return p.substr(0, p.find_last_of(L"\\/"));
}

bool FileExists(const std::wstring& p) {
  DWORD a = GetFileAttributesW(p.c_str());
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

bool DirExists(const std::wstring& p) {
  DWORD a = GetFileAttributesW(p.c_str());
  return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}

void Fail(const std::wstring& msg) {
  if (g_splash) DestroyWindow(g_splash);
  MessageBoxW(nullptr, msg.c_str(), kTitle, MB_ICONERROR | MB_OK);
  ExitProcess(1);
}

std::wstring ReadTail(const std::wstring& path, size_t max) {
  HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                         OPEN_EXISTING, 0, nullptr);
  if (h == INVALID_HANDLE_VALUE) return L"";
  LARGE_INTEGER size{};
  GetFileSizeEx(h, &size);
  LONGLONG start = size.QuadPart > (LONGLONG)max ? size.QuadPart - (LONGLONG)max : 0;
  LARGE_INTEGER pos{};
  pos.QuadPart = start;
  SetFilePointerEx(h, pos, nullptr, FILE_BEGIN);
  std::string bytes((size_t)(size.QuadPart - start), '\0');
  DWORD got = 0;
  ReadFile(h, bytes.data(), (DWORD)bytes.size(), &got, nullptr);
  CloseHandle(h);
  bytes.resize(got);
  int n = MultiByteToWideChar(CP_UTF8, 0, bytes.data(), (int)bytes.size(), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, bytes.data(), (int)bytes.size(), w.data(), n);
  return w;
}

bool PortFree(int port) {
  SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (s == INVALID_SOCKET) return false;
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_port = htons((u_short)port);
  inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
  bool ok = bind(s, (sockaddr*)&a, sizeof(a)) == 0;
  closesocket(s);
  return ok;
}

bool PortAnswers(int port) {
  SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (s == INVALID_SOCKET) return false;
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_port = htons((u_short)port);
  inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
  bool ok = connect(s, (sockaddr*)&a, sizeof(a)) == 0;
  closesocket(s);
  return ok;
}

void PumpMessages() {
  MSG m;
  while (PeekMessageW(&m, nullptr, 0, 0, PM_REMOVE)) {
    TranslateMessage(&m);
    DispatchMessageW(&m);
  }
}

void ShowSplash(const wchar_t* text) {
  if (!g_splash) {
    int w = 460, h = 110;
    int x = (GetSystemMetrics(SM_CXSCREEN) - w) / 2, y = (GetSystemMetrics(SM_CYSCREEN) - h) / 2;
    g_splash = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST, L"STATIC", L"",
                               WS_POPUP | WS_BORDER | SS_CENTER | SS_CENTERIMAGE, x, y, w, h, nullptr,
                               nullptr, GetModuleHandleW(nullptr), nullptr);
    HFONT f = CreateFontW(-16, 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0,
                          L"Segoe UI");
    SendMessageW(g_splash, WM_SETFONT, (WPARAM)f, TRUE);
    ShowWindow(g_splash, SW_SHOW);
  }
  SetWindowTextW(g_splash, text);
  UpdateWindow(g_splash);
  PumpMessages();
}

std::wstring Quote(const std::wstring& s) { return L"\"" + s + L"\""; }

// Edge or Chrome from the App Paths registry (machine or user) or the usual install folders.
std::wstring FindAppBrowser() {
  const wchar_t* exes[] = {L"msedge.exe", L"chrome.exe"};
  for (const wchar_t* exe : exes) {
    for (HKEY root : {HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE}) {
      std::wstring key = std::wstring(L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\") + exe;
      wchar_t buf[MAX_PATH * 2];
      DWORD size = sizeof(buf);
      if (RegGetValueW(root, key.c_str(), nullptr, RRF_RT_REG_SZ, nullptr, buf, &size) == ERROR_SUCCESS &&
          FileExists(buf))
        return buf;
    }
  }
  wchar_t pf[MAX_PATH], pf86[MAX_PATH], local[MAX_PATH];
  GetEnvironmentVariableW(L"ProgramFiles", pf, MAX_PATH);
  GetEnvironmentVariableW(L"ProgramFiles(x86)", pf86, MAX_PATH);
  GetEnvironmentVariableW(L"LOCALAPPDATA", local, MAX_PATH);
  std::vector<std::wstring> cands = {
      std::wstring(pf86) + L"\\Microsoft\\Edge\\Application\\msedge.exe",
      std::wstring(pf) + L"\\Microsoft\\Edge\\Application\\msedge.exe",
      std::wstring(pf) + L"\\Google\\Chrome\\Application\\chrome.exe",
      std::wstring(pf86) + L"\\Google\\Chrome\\Application\\chrome.exe",
      std::wstring(local) + L"\\Google\\Chrome\\Application\\chrome.exe"};
  for (auto& c : cands)
    if (FileExists(c)) return c;
  return L"";
}

// Lets the user pick the game folder; writes data\settings.json. Returns false on cancel.
bool AskGameFolder() {
  MessageBoxW(nullptr,
              Tr(L"Diablo II: Resurrected wurde nicht gefunden.\n\nBitte im nächsten Fenster den Spielordner "
                 L"wählen (der Ordner mit D2R.exe und .build.info).",
                 L"Diablo II: Resurrected was not found.\n\nPlease choose the game folder in the next window "
                 L"(the folder with D2R.exe and .build.info)."),
              kTitle, MB_ICONINFORMATION | MB_OK);
  IFileOpenDialog* dlg = nullptr;
  if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dlg))))
    return false;
  DWORD opts = 0;
  dlg->GetOptions(&opts);
  dlg->SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
  dlg->SetTitle(Tr(L"Spielordner von Diablo II: Resurrected", L"Diablo II: Resurrected game folder"));
  bool ok = false;
  if (SUCCEEDED(dlg->Show(nullptr))) {
    IShellItem* item = nullptr;
    if (SUCCEEDED(dlg->GetResult(&item))) {
      PWSTR path = nullptr;
      if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path))) {
        std::wstring p = path;
        CoTaskMemFree(path);
        std::string esc;  // JSON string, UTF-8
        int n = WideCharToMultiByte(CP_UTF8, 0, p.c_str(), (int)p.size(), nullptr, 0, nullptr, nullptr);
        std::string u(n, '\0');
        WideCharToMultiByte(CP_UTF8, 0, p.c_str(), (int)p.size(), u.data(), n, nullptr, nullptr);
        for (char c : u) {
          if (c == '\\' || c == '"') esc += '\\';
          esc += c;
        }
        std::string json = "{\"game\": \"" + esc + "\"}\n";
        HANDLE h = CreateFileW((g_data + L"\\settings.json").c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                               0, nullptr);
        if (h != INVALID_HANDLE_VALUE) {
          DWORD w = 0;
          WriteFile(h, json.data(), (DWORD)json.size(), &w, nullptr);
          CloseHandle(h);
          ok = true;
        }
      }
      item->Release();
    }
  }
  dlg->Release();
  return ok;
}

struct Server {
  PROCESS_INFORMATION pi{};
  HANDLE job = nullptr;
};

Server StartServer(int port) {
  std::wstring python = g_dir + L"\\runtime\\python.exe";
  std::wstring server = g_dir + L"\\app\\server.py";
  if (!FileExists(server)) {  // dev checkout: launcher\launcher.exe next to server.py
    server = g_dir + L"\\..\\server.py";
    if (!FileExists(server)) Fail(Tr(L"app\\server.py fehlt neben D2REditor.exe.", L"app\\server.py is missing next to D2REditor.exe."));
  }
  if (!FileExists(python)) python = L"python.exe";

  std::wstring log = g_data + L"\\server.log";
  SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
  HANDLE out = CreateFileW(log.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, CREATE_ALWAYS,
                           FILE_ATTRIBUTE_NORMAL, nullptr);

  SetEnvironmentVariableW(L"D2R_EDITOR_DATA", g_data.c_str());

  // -I ignores PYTHON* variables, so unbuffered output and UTF-8 are set by flags
  std::wstring cmd = Quote(python) + L" -I -u -X utf8 " + Quote(server) + L" " + std::to_wstring(port);
  STARTUPINFOW si{sizeof(si)};
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdOutput = out;
  si.hStdError = out;
  si.hStdInput = nullptr;
  Server s;
  if (!CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr,
                      g_data.c_str(), &si, &s.pi))
    Fail(std::wstring(Tr(L"Python konnte nicht gestartet werden:\n", L"Could not start Python:\n")) + cmd);
  // The server (and the test it may start) ends with the launcher, even if the launcher is killed.
  s.job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION li{};
  li.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  SetInformationJobObject(s.job, JobObjectExtendedLimitInformation, &li, sizeof(li));
  AssignProcessToJobObject(s.job, s.pi.hProcess);
  ResumeThread(s.pi.hThread);
  CloseHandle(s.pi.hThread);
  if (out != INVALID_HANDLE_VALUE) CloseHandle(out);
  return s;
}

// Waits until the server listens. Returns the server's exit code if it ended, or -1 when ready.
int WaitReady(Server& s, int port) {
  ULONGLONG start = GetTickCount64();
  bool long_note = false;
  for (;;) {
    if (WaitForSingleObject(s.pi.hProcess, 0) == WAIT_OBJECT_0) {
      DWORD code = 1;
      GetExitCodeProcess(s.pi.hProcess, &code);
      return (int)code;
    }
    if (PortAnswers(port)) return -1;
    if (!long_note && GetTickCount64() - start > 4000) {
      long_note = true;
      ShowSplash(Tr(L"D2R Level Editor startet …\nBeim ersten Start wird die Dateiliste des Spiels erstellt (etwa 1 Minute).",
                    L"D2R Level Editor is starting …\nThe first start builds the game's file list (about 1 minute)."));
    }
    for (int i = 0; i < 4; i++) {
      PumpMessages();
      Sleep(50);
    }
  }
}

}  // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  WSADATA wsa;
  WSAStartup(MAKEWORD(2, 2), &wsa);

  g_dir = ExeDir();
  g_data = g_dir + L"\\data";
  if (!DirExists(g_data) && !DirExists(g_dir + L"\\app")) g_data = g_dir + L"\\..";  // dev checkout
  // data_path.txt next to the exe points at another data folder (shared with the source checkout).
  std::wstring linked = ReadTail(g_dir + L"\\data_path.txt", 4096);
  while (!linked.empty() && (linked.back() == L'\n' || linked.back() == L'\r' || linked.back() == L' '))
    linked.pop_back();
  if (!linked.empty() && linked[0] == 0xFEFF) linked.erase(0, 1);
  if (!linked.empty()) {
    if (!DirExists(linked))
      Fail(std::wstring(Tr(L"Der Datenordner aus data_path.txt fehlt:\n", L"The data folder from data_path.txt is missing:\n")) + linked);
    g_data = linked;
  }
  CreateDirectoryW(g_data.c_str(), nullptr);

  // One editor at a time: a second start only brings up a new window of the running one.
  HANDLE mutex = CreateMutexW(nullptr, TRUE, L"Local\\D2RLevelEditor");
  bool second = GetLastError() == ERROR_ALREADY_EXISTS;

  int port = 8765;
  Server server;
  if (second) {
    std::wstring p = ReadTail(g_data + L"\\port.txt", 16);
    port = p.empty() ? 8765 : _wtoi(p.c_str());
  } else {
    while (port < 8800 && !PortFree(port)) port++;
    std::string ps = std::to_string(port);
    HANDLE h = CreateFileW((g_data + L"\\port.txt").c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                           CREATE_ALWAYS, 0, nullptr);
    if (h != INVALID_HANDLE_VALUE) {
      DWORD w = 0;
      WriteFile(h, ps.data(), (DWORD)ps.size(), &w, nullptr);
      CloseHandle(h);
    }
    for (;;) {
      server = StartServer(port);
      int code = WaitReady(server, port);
      if (code < 0) break;
      CloseHandle(server.pi.hProcess);
      CloseHandle(server.job);
      if (code == 3 && AskGameFolder()) {  // game folder missing: ask, then start again with settings.json
        SetEnvironmentVariableW(L"D2R_GAME", nullptr);
        continue;
      }
      if (code == 3) return 1;
      Fail(std::wstring(Tr(L"Der Editor-Server wurde beendet (Code ", L"The editor server stopped (code ")) + std::to_wstring(code) + L").\n\nserver.log:\n" +
           ReadTail(g_data + L"\\server.log", 1500));
    }
  }
  if (g_splash) {
    DestroyWindow(g_splash);
    g_splash = nullptr;
  }

  std::wstring url = L"http://127.0.0.1:" + std::to_wstring(port) + L"/";
  std::wstring browser = FindAppBrowser();
  if (!browser.empty()) {
    // Own profile folder: the window is its own browser process, so closing it ends the editor.
    std::wstring profile = g_data + L"\\editor_state\\browser";
    std::wstring cmd = Quote(browser) + L" --app=" + url + L" --user-data-dir=" + Quote(profile) +
                       L" --no-first-run --no-default-browser-check --disable-features=Translate" +
                       L" --window-size=1600,950";
    STARTUPINFOW si{sizeof(si)};
    PROCESS_INFORMATION pi{};
    if (CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &pi)) {
      CloseHandle(pi.hThread);
      if (!second) {
        WaitForSingleObject(pi.hProcess, INFINITE);
        // The app window may hand off to a profile process that is still open: wait for the profile lock.
        std::wstring lock = profile + L"\\lockfile";
        for (int i = 0; i < 20 * 60 * 24 && FileExists(lock); i++) {
          HANDLE h = CreateFileW(lock.c_str(), DELETE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_DELETE_ON_CLOSE, nullptr);
          if (h != INVALID_HANDLE_VALUE) {
            CloseHandle(h);
            break;
          }
          Sleep(3000);
        }
      }
      CloseHandle(pi.hProcess);
    }
  } else {
    ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    if (!second)
      MessageBoxW(nullptr, Tr(L"Der Editor läuft im Browser.\n\nOK beendet den Editor (vorher speichern).",
                             L"The editor runs in your browser.\n\nOK stops the editor (save first)."), kTitle,
                  MB_ICONINFORMATION | MB_OK);
  }

  if (!second) {
    TerminateProcess(server.pi.hProcess, 0);
    CloseHandle(server.job);
    DeleteFileW((g_data + L"\\port.txt").c_str());
  }
  if (mutex) CloseHandle(mutex);
  WSACleanup();
  return 0;
}
