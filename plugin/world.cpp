// d2r-world: D2RLoader plugin for new areas added by a mod (tools/new_zone.py).
//
//  - New towns: DUNGEON_IsTownLevelId (RVA 0x327850) is hard-wired to the five act towns
//    (1, 40, 75, 103, 109). It is replaced so that the towns listed in the config count as
//    towns too (safe zone, town behaviour of NPCs and portals).
//  - Coming back: the game puts a character into the town of its saved act when it joins. When
//    a character left the game in one of the new levels, the plugin brings it to that area's hub
//    town again: LEVEL_WarpUnit(game, unit, levelId, type) at RVA 0x488180 (the call a waypoint
//    makes). The last area is kept per character in d2r-world-state.txt next to the DLL.
//
// Other game functions: 0x408670 per-game server update (hooked, once per frame), 0x48FE80
// SUNIT_GetServerUnit, 0x34B440 UNITS_GetRoom, 0x2EFC10 DUNGEON_GetLevelIdFromRoom.
// Player name: PlayerData (unit+0x10) starts with the character name.
//
// Config d2r-world.ini next to the DLL:
//   towns=138                 extra town levels
//   world=138                 levels of the new world (leaving there means coming back there)
//   hub=138                   where a returning character arrives
//   hub_warp_type=0           LEVEL_WarpUnit type: 0 = at the level's waypoint, 13 = town start
//   return_delay_frames=40    frames after joining before the warp
//   waypoint=138,0,1,Name     a World Waypoints entry: level, LEVEL_WarpUnit type, open from the
//                             start (else once the character has been there), button text
//   debug_ui=1                log every UI message to d2r-world.log
//   ui_test=1                 automatic test: open the window, then travel with its first button
//   ui_test=2 / 3             test with clicks: opens the game's waypoint panel (2) or the window (3)
//                             and fakes the mouse from d2r-world-cursor.txt ("x y [down]")
//
// World Waypoints: a second waypoint menu, an in-game window (D2RLoader panel) with one button
// per new area, eight per page. It opens with Ctrl+W, the console command world-waypoints, or
// the "World Waypoints" button that the editor export adds to the game's waypoint panel. The
// areas a character has been to are kept in d2r-world-waypoints.txt next to the DLL.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>
#pragma comment(lib, "user32.lib")

#include <D2RLPlugin/api.h>

#include <array>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cctype>
#include <cstring>
#include <atomic>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <vector>

namespace {

const D2RL::PluginInfo Info{
    .infoSize = D2RL::PluginInfoSize,
    .apiVersion = D2RL_PLUGIN_API_VERSION,
    .id = "d2r-world",
    .name = "New World Areas",
    .version = "0.2.0",
    .author = "local",
    .description = "Extra towns, a World Waypoints window and returning to new areas for mods that add levels.",
    .flags = D2RL::PluginFlags::Shared | D2RL::PluginFlags::NativeHooks,
    .reserved = {},
};

constexpr std::uint32_t UpdateRva = 0x408670;
constexpr std::array<std::uint8_t, 12> UpdateBytes{0x40, 0x55, 0x57, 0x41, 0x55, 0x48, 0x8B, 0xEC, 0x48, 0x83, 0xEC, 0x70};
constexpr std::uint32_t IsTownRva = 0x327850;
// sub ecx,1 / je / sub ecx,27h / je / sub ecx,23h / je (the original is never called)
constexpr std::array<std::uint8_t, 15> IsTownBytes{0x83, 0xE9, 0x01, 0x74, 0x17, 0x83, 0xE9, 0x27, 0x74, 0x12,
                                                    0x83, 0xE9, 0x23, 0x74, 0x0D};

using UpdateFn = void(__fastcall*)(void* game);
using IsTownFn = std::uint64_t(__fastcall*)(int levelId);
using GetServerUnitFn = void*(__fastcall*)(void* game, std::uint32_t type, std::uint32_t guid);
using UnitFn = void*(__fastcall*)(void* unit);
using LevelIdFn = int(__fastcall*)(void* room);
using WarpFn = void(__fastcall*)(void* game, void* unit, int levelId, int type);

UpdateFn OrigUpdate = nullptr;
IsTownFn OrigIsTown = nullptr;
GetServerUnitFn GetServerUnit = nullptr;
UnitFn GetRoom = nullptr;
LevelIdFn LevelIdOf = nullptr;
WarpFn LevelWarp = nullptr;

struct Destination {
    int level = 0, warpType = 0;
    bool always = false;
    std::string name;
};

struct Config {
    std::set<int> towns, world;
    int hub = -1, hubWarpType = 0, returnDelay = 40;
    bool debugUi = false, uiTest = false;
    int uiTestMode = 0;
    std::vector<Destination> waypoints;
} Cfg;

struct PlayerState {
    int seenFrames = 0;
    bool returned = false;
    int lastLevel = -1;
};
std::map<std::pair<void*, std::uint32_t>, PlayerState> Players;  // (game, player guid)
std::map<std::string, int> LastArea;                               // character -> level of the new world
std::map<std::string, ULONGLONG> ReturnedAt;                       // one return per join (the hook can see a player twice)
std::string Dir;

void Log(const char* fmt, ...) {
    FILE* f = std::fopen((Dir + "\\d2r-world.log").c_str(), "a");
    if (!f) return;
    SYSTEMTIME t;
    GetLocalTime(&t);
    std::fprintf(f, "[%02d:%02d:%02d] ", t.wHour, t.wMinute, t.wSecond);
    va_list a;
    va_start(a, fmt);
    std::vfprintf(f, fmt, a);
    va_end(a);
    std::fputc('\n', f);
    std::fclose(f);
}

void ParseList(const char* text, std::set<int>& out) {
    out.clear();
    std::string s(text);
    for (char* t = std::strtok(s.data(), ", \r\n"); t; t = std::strtok(nullptr, ", \r\n")) out.insert(std::atoi(t));
}

void ReadConfig() {
    const std::string path = Dir + "\\d2r-world.ini";
    FILE* f = std::fopen(path.c_str(), "r");
    if (!f) return;
    char line[1024];
    while (std::fgets(line, sizeof line, f)) {
        int v = 0;
        if (std::strncmp(line, "towns=", 6) == 0) ParseList(line + 6, Cfg.towns);
        if (std::strncmp(line, "world=", 6) == 0) ParseList(line + 6, Cfg.world);
        if (std::sscanf(line, "hub=%d", &v) == 1) Cfg.hub = v;
        if (std::sscanf(line, "hub_warp_type=%d", &v) == 1) Cfg.hubWarpType = v;
        if (std::sscanf(line, "return_delay_frames=%d", &v) == 1) Cfg.returnDelay = v;
        if (std::sscanf(line, "debug_ui=%d", &v) == 1) Cfg.debugUi = v != 0;
        if (std::sscanf(line, "ui_test=%d", &v) == 1) { Cfg.uiTest = v != 0; Cfg.uiTestMode = v; }
        Destination d;
        int always = 0, used = 0;
        if (std::sscanf(line, "waypoint=%d,%d,%d,%n", &d.level, &d.warpType, &always, &used) == 3 && used > 0) {
            d.always = always != 0;
            d.name = line + used;
            while (!d.name.empty() && (d.name.back() == '\n' || d.name.back() == '\r' || d.name.back() == ' ')) d.name.pop_back();
            for (char& c : d.name)
                if (c == '"' || c == '\\') c = ' ';  // goes into the panel JSON
            if (d.name.empty()) d.name = "Level " + std::to_string(d.level);
            Cfg.waypoints.push_back(d);
        }
    }
    std::fclose(f);
}

void LoadState() {
    FILE* f = std::fopen((Dir + "\\d2r-world-state.txt").c_str(), "r");
    if (!f) return;
    char name[64];
    int level = 0;
    while (std::fscanf(f, "%63s %d", name, &level) == 2) LastArea[name] = level;
    std::fclose(f);
}

void SaveState() {
    FILE* f = std::fopen((Dir + "\\d2r-world-state.txt").c_str(), "w");
    if (!f) return;
    for (const auto& [name, level] : LastArea) std::fprintf(f, "%s %d\n", name.c_str(), level);
    std::fclose(f);
}

std::string PlayerName(void* unit) {
    auto* data = *reinterpret_cast<char**>(static_cast<std::uint8_t*>(unit) + 0x10);
    if (!data) return {};
    char name[17]{};
    std::memcpy(name, data, 16);
    for (char& c : name)
        if (c && !(std::isalnum(static_cast<unsigned char>(c)) || c == '_' || c == '-')) c = '_';
    return name;
}

// ---- World Waypoints window ---------------------------------------------------------------

std::mutex StateMutex;                          // Visited and CurrentName: game and UI thread
std::map<std::string, std::set<int>> Visited;   // character -> levels of the world it has seen
std::string CurrentName;                        // the character in the game right now
std::atomic<int> PendingTravel{-1};             // index into Cfg.waypoints, done on the game thread
std::atomic<int> UiTestStep{0};

bool IsDestination(int level) {  // a World Waypoints entry opens once the character has been there
    for (const auto& d : Cfg.waypoints)
        if (d.level == level) return true;
    return false;
}

void LoadVisited() {
    FILE* f = std::fopen((Dir + "\\d2r-world-waypoints.txt").c_str(), "r");
    if (!f) return;
    char line[2048];
    while (std::fgets(line, sizeof line, f)) {
        char* name = std::strtok(line, " \r\n");
        if (!name) continue;
        auto& set = Visited[name];
        for (char* t = std::strtok(nullptr, " \r\n"); t; t = std::strtok(nullptr, " \r\n")) set.insert(std::atoi(t));
    }
    std::fclose(f);
}

void SaveVisited() {  // StateMutex held
    FILE* f = std::fopen((Dir + "\\d2r-world-waypoints.txt").c_str(), "w");
    if (!f) return;
    for (const auto& [name, levels] : Visited) {
        std::fprintf(f, "%s", name.c_str());
        for (int l : levels) std::fprintf(f, " %d", l);
        std::fputc('\n', f);
    }
    std::fclose(f);
}

constexpr int PageSize = 8;
// One panel per page of eight destinations: d2r-world/WorldWaypoints, ...Waypoints2, ...
// (a hidden button still takes clicks, so the pages cannot share one panel).
constexpr const char* PanelPrefix = "d2r-world/WorldWaypoints";
constexpr const char* Target = "WorldWaypoints";
// Buttons in layouts send "PanelManager:OpenPanel:d2r-world/<command>". The game drops button
// messages whose target or command it does not know (a custom "WorldWaypoints:Travel0" never
// arrives), but it passes any text. The listener takes these messages before the panel manager
// would look for a panel of that name.
constexpr const char* ButtonTarget = "PanelManager:OpenPanel:d2r-world/";

struct Ui {
    const D2RL::PluginContext* context{};
    const D2RL::PanelServiceV1* panels{};
    const D2RL::WidgetServiceV1* widgets{};
    const D2RL::ResourceServiceV1* resources{};
    const D2RL::SharedEventServiceV1* events{};
    const D2RL::ThreadServiceV1* threads{};
    const D2RL::InputServiceV1* input{};
    std::vector<D2RL::Resources::RegistrationHandle> layouts;
    std::vector<D2RL::Panels::RegistrationHandle> panels_;  // one per page
    D2RL::SharedEvents::ListenerHandle messages{};
    D2RL::Input::ActionHandle action{};
    D2RL::Widgets::WidgetHandle root{};
    int page = 0;
} UiState;

std::string Num(int v) { return std::to_string(v); }

int PageCount() { return static_cast<int>((Cfg.waypoints.size() + PageSize - 1) / PageSize); }

std::string PageId(int page) { return "WorldWaypoints" + (page ? Num(page + 1) : std::string()); }

std::string PanelLayout(int page) {
    // The look of the game's waypoint panel (same positions), with the blue-green sprites the
    // editor export writes to data/hd/global/ui/panel/worldwaypoints/.
    std::string j = std::string(R"({"type":"Panel","name":"d2r-world/)") + PageId(page) +
        R"(","fields":{"rect":"$LeftPanelRect","anchor":"$LeftPanelAnchor","priority":8400},"children":[)"
        R"({"type":"ClickCatcherWidget","name":"ClickCatcher","fields":{"rect":"$PanelClickCatcherRect"}},)"
        R"({"type":"ImageWidget","name":"Background","fields":{"rect":{"x":0,"y":0},"filename":"PANEL\\WorldWaypoints\\World_Base","frame":0}},)"
        R"({"type":"ImageWidget","name":"LeftHinge","fields":{"rect":"$LeftHingeRect","filename":"$LeftHingeSprite"}},)"
        R"({"type":"TextBoxWidget","name":"Title","fields":{"rect":"$InGamePanelTitleRect","text":"World Waypoints","style":"$StyleTitleBlock"}},)"
        R"({"type":"TextBoxWidget","name":"Header","fields":{"rect":{"x":152,"y":205,"width":858,"height":55},"text":"New areas","style":{"fontColor":"$FontColorLightTeal","pointSize":"$MediumPanelFontSize","alignment":{"h":"center","v":"center"}}}},)"
        R"({"type":"ImageWidget","name":"Overlay","fields":{"rect":{"x":150,"y":201},"filename":"PANEL\\WorldWaypoints\\World_Overlay"}},)";
    // Buttons send their own message (onClickMessage); the widget service of D2RLoader 1.3.1
    // cannot set event messages or texts later, so every text is in the layout.
    auto button = [&](const std::string& name, int x, int y, const char* sprite, const std::string& text, const char* color,
                      const std::string& command, bool visible) {
        j += R"({"type":"ButtonWidget","name":")" + name + R"(","fields":{"rect":{"x":)" + Num(x) + R"(,"y":)" + Num(y) +
             R"(},"filename":"PANEL\\)" + sprite + R"(","hoveredFrame":1,"textString":")" + text +
             R"(","pointSize":"$MediumPanelFontSize","textColor":")" + color + R"(","visible":)" + (visible ? "true" : "false") +
             (command.empty() ? std::string() : std::string(R"(,"onClickMessage":")") + ButtonTarget + command + "\"") + "}},";
    };
    const int first = page * PageSize;
    const int last = (std::min)(first + PageSize, static_cast<int>(Cfg.waypoints.size()));
    for (int i = first; i < last; ++i) {
        const int y = 264 + 123 * (i - first);
        const std::string n = Num(i);
        // the locked look first: a hidden widget still takes clicks, so the button on top must be
        // the one that travels (the listener ignores destinations that are not open yet)
        button("Locked" + n, 152, y, "WorldWaypoints\\\\World_Button_Disabled", Cfg.waypoints[i].name, "$FontColorGray", "", false);
        button("Go" + n, 152, y, "WorldWaypoints\\\\World_Button", Cfg.waypoints[i].name, "$FontColorLightTeal", "Travel" + n, true);
    }
    const int pages = PageCount();
    if (pages > 1) {
        if (page > 0) button("PrevPage", 152, 1262, "WorldWaypoints\\\\World_Tab", "<", "$FontColorWhite", "Prev", true);
        if (page < pages - 1) button("NextPage", 836, 1262, "WorldWaypoints\\\\World_Tab", ">", "$FontColorWhite", "Next", true);
        j += R"({"type":"TextBoxWidget","name":"PageText","fields":{"rect":{"x":330,"y":1262,"width":500,"height":82},"text":"Page )" +
             Num(page + 1) + " / " + Num(pages) +
             R"(","style":{"fontColor":"$FontColorLightTeal","pointSize":"$MediumPanelFontSize","alignment":{"h":"center","v":"center"}}}},)";
    }
    j += std::string(R"({"type":"ButtonWidget","name":"CloseButton","fields":{"rect":{"x":1075,"y":9},"filename":"PANEL\\closebtn_4x","hoveredFrame":3,"sound":"cursor_close_window_hd","onClickMessage":")") + ButtonTarget + R"(Close"}})";
    return j + "]}";
}

D2RL::Widgets::WidgetHandle FindWidget(const std::string& name) {
    D2RL::Widgets::WidgetHandle h{};
    if (!UiState.root || UiState.widgets->findWidget(UiState.context, UiState.root, name.c_str(), &h) != D2RL::Widgets::Result::Success) return 0;
    return h;
}

void Show(const std::string& name, bool visible) {
    if (const auto h = FindWidget(name)) UiState.widgets->setWidgetVisible(UiState.context, h, visible);
}

int OpenPage() {  // the page whose panel is open, or -1
    for (int p = 0; p < static_cast<int>(UiState.panels_.size()); ++p) {
        D2RL::Panels::PanelInfo info{};
        info.structSize = D2RL::Panels::PanelInfoSize;
        if (UiState.panels->getPanelInfo(UiState.context, UiState.panels_[p], &info) == D2RL::Panels::Result::Success &&
            info.presentationState == D2RL::Panels::PresentationState::Open)
            return p;
    }
    return -1;
}

bool IsOpen() { return OpenPage() >= 0; }

void Render() {  // locked destinations show the grey button
    std::set<int> seen;
    {
        std::lock_guard lock(StateMutex);
        const auto it = Visited.find(CurrentName);
        if (it != Visited.end()) seen = it->second;
    }
    const int first = UiState.page * PageSize;
    const int last = (std::min)(first + PageSize, static_cast<int>(Cfg.waypoints.size()));
    for (int i = first; i < last; ++i) {
        const bool open = Cfg.waypoints[i].always || seen.count(Cfg.waypoints[i].level) > 0;
        Show("Go" + Num(i), open);
        Show("Locked" + Num(i), !open);
    }
}

void CloseWindow() {
    const int p = OpenPage();
    if (p >= 0) UiState.panels->closePanel(UiState.context, UiState.panels_[p]);
}

void OpenWindow(int page = -1) {
    if (UiState.panels_.empty()) return;
    if (page < 0) page = UiState.page;
    page = (std::min)((std::max)(page, 0), static_cast<int>(UiState.panels_.size()) - 1);
    const int open = OpenPage();
    if (open == page) return;
    if (open >= 0) UiState.panels->closePanel(UiState.context, UiState.panels_[open]);
    // the game's waypoint panel uses the same place on the screen
    const D2RL::Widgets::UiAction close{D2RL::Widgets::UiActionSize, 0, "Waypoints", "CloseWaypointPanel", ""};
    UiState.widgets->dispatchUiAction(UiState.context, &close);
    const auto r = UiState.panels->openPanel(UiState.context, UiState.panels_[page]);
    if (r != D2RL::Panels::Result::Success) {
        Log("World Waypoints: open failed (%u)", static_cast<unsigned>(r));
        return;
    }
    UiState.page = page;
    UiState.root = 0;
    const std::string name = "d2r-world/" + PageId(page);
    const auto f = UiState.widgets->findPanel(UiState.context, name.c_str(), &UiState.root);
    if (f != D2RL::Widgets::Result::Success || !UiState.root) {
        Log("World Waypoints: panel not found after open (%u)", static_cast<unsigned>(f));
        return;
    }
    Render();
    Log("World Waypoints: window open, page %d", page + 1);
}

void __cdecl OpenOnUi(const D2RL::PluginContext*, void*) noexcept {
    try {
        OpenWindow();
    } catch (...) {}
}

void __cdecl ToggleOnUi(const D2RL::PluginContext*, void*) noexcept {
    try {
        if (IsOpen()) CloseWindow();
        else OpenWindow();
    } catch (...) {}
}

void __cdecl TestTravelOnUi(const D2RL::PluginContext* context, void*) noexcept {
    // the same message path as a click on the first destination button
    const D2RL::Widgets::UiAction travel{D2RL::Widgets::UiActionSize, 0, Target, "Travel0", ""};
    const auto r = UiState.widgets->dispatchUiAction(context, &travel);
    Log("ui test: dispatched Travel0 (%u)", static_cast<unsigned>(r));
}

// UI test only: the game reads the mouse position with GetCursorPos. To click its widgets
// without moving the real mouse, the test script writes a screen position into
// d2r-world-cursor.txt ("x y", empty = real cursor) and sends the button messages to the window.
// While the cursor is faked the real one is outside the window, so Windows reports
// WM_MOUSELEAVE and the game stops hovering its widgets; the test drops that message.
WNDPROC GameWndProc = nullptr;
bool FakeActive = false, FakeDown = false;
LRESULT CALLBACK TestWndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_MOUSELEAVE && FakeActive) return 0;
    return CallWindowProcW(GameWndProc, h, msg, wp, lp);
}
BOOL CALLBACK FindGameWindow(HWND h, LPARAM out) {
    DWORD pid = 0;
    GetWindowThreadProcessId(h, &pid);
    wchar_t title[64]{};
    GetWindowTextW(h, title, 64);
    if (pid == GetCurrentProcessId() && IsWindowVisible(h) && std::wcsncmp(title, L"Diablo II", 9) == 0) {
        *reinterpret_cast<HWND*>(out) = h;
        return FALSE;
    }
    return TRUE;
}
void SubclassGameWindow() {
    if (GameWndProc) return;
    HWND h = nullptr;
    EnumWindows(FindGameWindow, reinterpret_cast<LPARAM>(&h));
    if (!h) return;
    GameWndProc = reinterpret_cast<WNDPROC>(SetWindowLongPtrW(h, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(&TestWndProc)));
    Log("ui test: game window subclassed");
}

bool FakeCursor(LPPOINT p) {
    static ULONGLONG checked = 0;
    static bool active = false;
    static POINT pos{};
    const ULONGLONG now = GetTickCount64();
    if (now - checked > 30) {
        checked = now;
        active = false;
        if (FILE* f = std::fopen((Dir + "\\d2r-world-cursor.txt").c_str(), "r")) {
            int down = 0;
            const int got = std::fscanf(f, "%ld %ld %d", &pos.x, &pos.y, &down);
            active = got >= 2;
            FakeDown = active && got == 3 && down != 0;
            std::fclose(f);
        }
        if (active) SubclassGameWindow();
        FakeActive = active;
    }
    if (active && p) *p = pos;
    return active;
}

BOOL WINAPI TestCursorPos(LPPOINT p) {
    if (FakeCursor(p)) return TRUE;
    CURSORINFO info{sizeof(CURSORINFO)};  // the real position without the patched functions
    if (!GetCursorInfo(&info)) return FALSE;
    if (p) *p = info.ptScreenPos;
    return TRUE;
}

// The left button state for a faked click ("x y 1" in the file); other keys from win32u.
using KeyFn = SHORT(WINAPI*)(int);
KeyFn NtAsyncKey = nullptr, NtKey = nullptr;
SHORT WINAPI TestGetAsyncKeyState(int key) {
    FakeCursor(nullptr);
    if (key == VK_LBUTTON && FakeActive) return FakeDown ? static_cast<SHORT>(0x8000) : 0;
    return NtAsyncKey ? NtAsyncKey(key) : 0;
}
SHORT WINAPI TestGetKeyState(int key) {
    FakeCursor(nullptr);
    if (key == VK_LBUTTON && FakeActive) return FakeDown ? static_cast<SHORT>(0x8000) : 0;
    return NtKey ? NtKey(key) : 0;
}

void Redirect(const char* name, const void* to) {
    auto* target = reinterpret_cast<std::uint8_t*>(GetProcAddress(GetModuleHandleW(L"user32.dll"), name));
    if (!target) return;
    std::uint8_t code[12] = {0x48, 0xB8, 0, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0xE0};  // mov rax, imm64 / jmp rax
    const auto addr = reinterpret_cast<std::uint64_t>(to);
    std::memcpy(code + 2, &addr, 8);
    DWORD old = 0;
    if (!VirtualProtect(target, sizeof code, PAGE_EXECUTE_READWRITE, &old)) return;
    std::memcpy(target, code, sizeof code);
    VirtualProtect(target, sizeof code, old, &old);
    FlushInstructionCache(GetCurrentProcess(), target, sizeof code);
    Log("ui test: %s redirected", name);
}

// The game is mapped by D2RLoader and has no import table to patch, so the user32 functions
// themselves jump to TestCursorPos (in this process only, and only with ui_test).
void RedirectCursor(const char* name) {
    auto* target = reinterpret_cast<std::uint8_t*>(GetProcAddress(GetModuleHandleW(L"user32.dll"), name));
    if (!target) return;
    std::uint8_t code[12] = {0x48, 0xB8, 0, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0xE0};  // mov rax, imm64 / jmp rax
    const auto to = reinterpret_cast<std::uint64_t>(&TestCursorPos);
    std::memcpy(code + 2, &to, 8);
    DWORD old = 0;
    if (!VirtualProtect(target, sizeof code, PAGE_EXECUTE_READWRITE, &old)) return;
    std::memcpy(target, code, sizeof code);
    VirtualProtect(target, sizeof code, old, &old);
    FlushInstructionCache(GetCurrentProcess(), target, sizeof code);
    Log("ui test: %s redirected", name);
}

void __cdecl OpenNativeOnUi(const D2RL::PluginContext* context, void*) noexcept {
    // the game's own waypoint panel, as a click on a waypoint opens it
    const D2RL::Widgets::UiAction open{D2RL::Widgets::UiActionSize, 0, "PanelManager", "OpenPanel", "WaypointsPanelExpansion"};
    const auto r = UiState.widgets->dispatchUiAction(context, &open);
    Log("ui test: native waypoint panel opened (%u)", static_cast<unsigned>(r));
}

D2RL::SharedEvents::UiMessageAction __cdecl OnUiMessage(const D2RL::PluginContext*, const D2RL::SharedEvents::UiMessageEvent* e, void*) noexcept {
    using Action = D2RL::SharedEvents::UiMessageAction;
    if (!e || e->structSize < D2RL::SharedEvents::UiMessageEventRequiredSize || !e->target || !e->command) return Action::Continue;
    if (Cfg.debugUi) Log("ui message %s:%s (%s)", e->target, e->command, e->text ? e->text : "");
    std::string command;
    if (std::strcmp(e->target, Target) == 0) command = e->command;  // dispatchUiAction, console
    else if (std::strcmp(e->target, "PanelManager") == 0 && std::strcmp(e->command, "OpenPanel") == 0 && e->text &&
             std::strncmp(e->text, "d2r-world/", 10) == 0 && std::strncmp(e->text, PanelPrefix, std::strlen(PanelPrefix)) != 0)
        command = e->text + 10;  // a button (the window itself opens through the same message)
    else return Action::Continue;
    try {
        if (command == "Open") OpenWindow();
        else if (command == "Close") CloseWindow();
        else if (command == "Prev") OpenWindow(UiState.page - 1);
        else if (command == "Next") OpenWindow(UiState.page + 1);
        else if (command.rfind("Travel", 0) == 0) {
            const int i = std::atoi(command.c_str() + 6);
            if (i >= 0 && i < static_cast<int>(Cfg.waypoints.size())) {
                bool open = Cfg.waypoints[i].always;
                {
                    std::lock_guard lock(StateMutex);
                    const auto it = Visited.find(CurrentName);
                    open = open || (it != Visited.end() && it->second.count(Cfg.waypoints[i].level));
                }
                if (open) {
                    PendingTravel = i;
                    CloseWindow();
                    Log("World Waypoints: travel to %s (level %d)", Cfg.waypoints[i].name.c_str(), Cfg.waypoints[i].level);
                }
            }
        }
    } catch (...) {}
    return Action::Consume;
}

D2RL::Input::ActionResult __cdecl OnKey(const D2RL::PluginContext*, const D2RL::Input::ActionEvent* e, void*) noexcept {
    if (!D2RL::Input::HasActionEventField(e, D2RL::Input::ActionEventRequiredSize) || e->kind != D2RL::Input::ActionEventKind::Pressed)
        return D2RL::Input::ActionResult::Ignored;
    UiState.threads->runOnUiThread(UiState.context, ToggleOnUi, nullptr);
    return D2RL::Input::ActionResult::Handled;
}

D2RL::ConsoleCommandResult OnCommand(D2R::Game::Client*, const D2RL::ConsoleCommandContext*, void*) noexcept {
    return UiState.threads->runOnUiThread(UiState.context, ToggleOnUi, nullptr) == D2RL::Threads::Result::Success
               ? D2RL::ConsoleCommandResult::Handled : D2RL::ConsoleCommandResult::Failed;
}

template <class S> bool Query(const D2RL::PluginContext* c, D2RL::ServiceId id, const S** out) {
    return c->QueryService(id, 1, out) == D2RL::ServiceQueryResult::Success && *out;
}

bool StartUi(const D2RL::PluginContext* c) {
    if (Cfg.waypoints.empty()) return false;
    auto& u = UiState;
    u.context = c;
    if (!Query(c, D2RL::ServiceId::Panel, &u.panels) || !Query(c, D2RL::ServiceId::Widget, &u.widgets) ||
        !Query(c, D2RL::ServiceId::Resource, &u.resources) || !Query(c, D2RL::ServiceId::SharedEvent, &u.events) ||
        !Query(c, D2RL::ServiceId::Thread, &u.threads)) {
        Log("World Waypoints: a D2RLoader service is missing; no window");
        return false;
    }
    Log("World Waypoints: widget service size %u", u.widgets->serviceSize);
    const D2RL::SharedEvents::UiMessageListener listener{D2RL::SharedEvents::UiMessageListenerSize, 0, 0, 0, OnUiMessage, nullptr};
    auto a = D2RL::Resources::Result::Success;
    auto b = D2RL::Panels::Result::Success;
    for (int page = 0; page < PageCount(); ++page) {
        const std::string json = PanelLayout(page), id = PageId(page);
        const std::string path = "data/global/ui/layouts/d2r-world/" + id + "hd.json";
        if (Cfg.debugUi && page == 0) {
            if (FILE* f = std::fopen((Dir + "\\d2r-world-panel.json").c_str(), "w")) {
                std::fputs(json.c_str(), f);
                std::fclose(f);
            }
        }
        const D2RL::Resources::ResourceRegistration res{D2RL::Resources::ResourceRegistrationSize, 0, path.c_str(), json.data(), json.size()};
        const D2RL::Panels::PanelRegistration reg{D2RL::Panels::PanelRegistrationSize, D2RL::Panels::PanelFlags::CloseOnEscape, id.c_str()};
        D2RL::Resources::RegistrationHandle l{};
        D2RL::Panels::RegistrationHandle h{};
        if (const auto r = u.resources->registerResource(c, &res, &l); r != D2RL::Resources::Result::Success) a = r;
        if (const auto r = u.panels->registerPanel(c, &reg, &h); r != D2RL::Panels::Result::Success) b = r;
        if (l) u.layouts.push_back(l);
        if (h) u.panels_.push_back(h);
    }
    const auto m = u.events->registerUiMessageListener(c, &listener, &u.messages);
    if (Cfg.uiTest) {
        RedirectCursor("GetCursorPos");
        RedirectCursor("GetPhysicalCursorPos");
        if (HMODULE w = LoadLibraryW(L"win32u.dll")) {
            NtAsyncKey = reinterpret_cast<KeyFn>(GetProcAddress(w, "NtUserGetAsyncKeyState"));
            NtKey = reinterpret_cast<KeyFn>(GetProcAddress(w, "NtUserGetKeyState"));
        }
        if (NtAsyncKey) Redirect("GetAsyncKeyState", reinterpret_cast<const void*>(&TestGetAsyncKeyState));
        if (NtKey) Redirect("GetKeyState", reinterpret_cast<const void*>(&TestGetKeyState));
    }
    Log("World Waypoints: layouts %u, panels %u (%zu pages), messages %u, %zu destinations", static_cast<unsigned>(a),
        static_cast<unsigned>(b), u.panels_.size(), static_cast<unsigned>(m), Cfg.waypoints.size());
    if (Query(c, D2RL::ServiceId::Input, &u.input)) {
        const D2RL::Input::ActionRegistration key{D2RL::Input::ActionRegistrationSize, 0, "world-waypoints", "World Waypoints", "New World Areas",
                                                  {D2RL::Input::Key::W, D2RL::Input::Modifier::Control},
                                                  {D2RL::Input::Key::None, D2RL::Input::Modifier::None}, OnKey, nullptr};
        if (u.input->registerAction(c, &key, &u.action) != D2RL::Input::Result::Success) u.action = 0;
    }
    D2RL::ConsoleCommandRegistration cmd{};
    cmd.registrationSize = D2RL::ConsoleCommandRegistrationSize;
    cmd.name = "world-waypoints";
    cmd.description = "Open the World Waypoints window.";
    cmd.callback = OnCommand;
    if (!c->RegisterConsoleCommand(cmd)) Log("World Waypoints: console command not registered");
    return a == D2RL::Resources::Result::Success && b == D2RL::Panels::Result::Success;
}

void StopUi() {
    auto& u = UiState;
    if (!u.context) return;
    if (u.action && u.input) u.input->unregisterAction(u.context, u.action);
    if (u.messages && u.events) u.events->unregisterUiMessageListener(u.context, u.messages);
    if (u.panels)
        for (const auto h : u.panels_) u.panels->unregisterPanel(u.context, h);
    if (u.resources)
        for (const auto h : u.layouts) u.resources->unregisterResource(u.context, h);
    u = Ui{};
}

std::uint64_t __fastcall IsTownDetour(int levelId) {
    switch (levelId) {
        case 1: case 40: case 75: case 103: case 109: return 1;
        default: return Cfg.towns.count(levelId) ? 1 : 0;
    }
}

void __fastcall UpdateDetour(void* game) {
    OrigUpdate(game);
    if (!game || Cfg.world.empty()) return;
    for (std::uint32_t guid = 0; guid < 16; ++guid) {
        void* player = GetServerUnit(game, 0, guid);
        if (!player) continue;
        void* room = GetRoom(player);
        if (!room) continue;
        const int level = LevelIdOf(room);
        PlayerState& s = Players[{game, guid}];
        const std::string name = PlayerName(player);
        if (name.empty()) continue;
        s.seenFrames += 1;
        if (!Cfg.waypoints.empty()) {
            std::lock_guard lock(StateMutex);
            CurrentName = name;
            if (IsDestination(level) && Visited[name].insert(level).second) SaveVisited();
        }
        if (const int t = PendingTravel.exchange(-1); t >= 0 && t < static_cast<int>(Cfg.waypoints.size())) {
            const Destination& d = Cfg.waypoints[t];
            Log("%s: world waypoint to %d (type %d) from level %d", name.c_str(), d.level, d.warpType, level);
            LevelWarp(game, player, d.level, d.warpType);
            continue;
        }
        if (Cfg.uiTest && UiState.threads) {  // automatic test of the window (ini ui_test=1)
            const int step = UiTestStep.load();
            if (step == 0 && s.seenFrames == 300) {
                UiTestStep = 1;
                Log("ui test %d: in level %d", Cfg.uiTestMode, level);
                // mode 1: open the window and travel by message; mode 2: open the game's waypoint
                // panel; the test script then clicks its World Waypoints button and a destination
                UiState.threads->runOnUiThread(UiState.context, Cfg.uiTestMode == 2 ? OpenNativeOnUi : OpenOnUi, nullptr);
            } else if (step == 1 && s.seenFrames == 600 && Cfg.uiTestMode == 1) {
                UiTestStep = 2;
                UiState.threads->runOnUiThread(UiState.context, TestTravelOnUi, nullptr);
            } else if (step >= 1 && step < 3 && s.seenFrames == 1500) {
                UiTestStep = 3;
                Log("ui test: now in level %d", level);
            }
        }
        if (!s.returned && s.seenFrames >= Cfg.returnDelay) {
            s.returned = true;
            const auto it = LastArea.find(name);
            const ULONGLONG now = GetTickCount64();
            if (it != LastArea.end() && Cfg.hub >= 0 && !Cfg.world.count(level) && now - ReturnedAt[name] > 10000) {
                ReturnedAt[name] = now;
                Log("%s joined in level %d; last area was %d: back to hub %d", name.c_str(), level, it->second, Cfg.hub);
                LevelWarp(game, player, Cfg.hub, Cfg.hubWarpType);
                continue;
            }
        }
        if (!s.returned || level == s.lastLevel) continue;
        s.lastLevel = level;
        const bool inWorld = Cfg.world.count(level) > 0;
        const auto it = LastArea.find(name);
        if (inWorld && (it == LastArea.end() || it->second != level)) {
            LastArea[name] = level;
            SaveState();
        } else if (!inWorld && it != LastArea.end()) {
            LastArea.erase(it);
            SaveState();
        }
    }
}

}  // namespace

D2RL_PLUGIN_EXPORT auto D2RLoaderGetPluginInfo() noexcept -> const D2RL::PluginInfo* { return &Info; }

D2RL_PLUGIN_EXPORT auto D2RLoaderLoadPlugin(const D2RL::PluginContext* context) noexcept -> bool {
    if (!D2RL::HasContext(context) || context->apiVersion < D2RL_PLUGIN_API_VERSION) return false;
    char path[MAX_PATH]{};
    HMODULE self{};
    GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       reinterpret_cast<LPCSTR>(&UpdateDetour), &self);
    GetModuleFileNameA(self, path, MAX_PATH);
    Dir = std::string(path).substr(0, std::string(path).find_last_of("\\/"));
    ReadConfig();
    LoadState();
    LoadVisited();
    const auto base = reinterpret_cast<std::uintptr_t>(GetModuleHandleW(nullptr));
    GetServerUnit = reinterpret_cast<GetServerUnitFn>(base + 0x48FE80);
    GetRoom = reinterpret_cast<UnitFn>(base + 0x34B440);
    LevelIdOf = reinterpret_cast<LevelIdFn>(base + 0x2EFC10);
    LevelWarp = reinterpret_cast<WarpFn>(base + 0x488180);
    const bool a = context->InstallInlineHook(D2RL::MakeInlineHook(
        UpdateRva, UpdateBytes.data(), static_cast<std::uint32_t>(UpdateBytes.size()),
        reinterpret_cast<void*>(&UpdateDetour), reinterpret_cast<void**>(&OrigUpdate)));
    const bool b = context->InstallInlineHook(D2RL::MakeInlineHook(
        IsTownRva, IsTownBytes.data(), static_cast<std::uint32_t>(IsTownBytes.size()),
        reinterpret_cast<void*>(&IsTownDetour), reinterpret_cast<void**>(&OrigIsTown)));
    Log("loaded: %zu extra towns, %zu world levels, hub %d; hooks update %d town %d", Cfg.towns.size(),
        Cfg.world.size(), Cfg.hub, a, b);
    if (!a || !b) D2RL::LogError(context, "New World Areas: hook failed, see d2r-world.log");
    if (a) StartUi(context);
    return a;
}

D2RL_PLUGIN_EXPORT void D2RLoaderUnloadPlugin() noexcept { StopUi(); }
