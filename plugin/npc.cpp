// d2r-npc: D2RLoader plugin for new NPCs made with the editor's NPC creator.
//
// A new NPC is a new monstats.txt row. What an NPC offers (talk, trade, repair, ...) is not in the
// data tables: the game keeps a fixed table of 43 town NPCs (RVA 0x237EA60, 0x1C bytes each, first
// a short with the monster class) and looks it up with NPC_GetRecord(version, class) at RVA
// 0x3971A0 (client menu, server trade, inventory). The vendor stock is looked up per class and
// difficulty at RVA 0x396800. The plugin answers both lookups for a new NPC with the record of the
// NPC whose behaviour it copies (for example Charsi: trade, with Charsi's goods). What it says is
// its own text, shown in the game's speech window (see "speech" below).
//
// Config d2r-npc.ini next to the DLL (written by the editor export):
//   npc=<class>,<base class>        a new NPC and the town NPC whose behaviour it has
//   speech=<class>,<string id>      what the NPC says (its own string in the mod's npcs.json)
//   speech_stage=<class>,<stage>,<string id>  what it says from that quest stage on; the stage is
//                                   read from d2r-quest-stage.txt (written by a quest plugin such as
//                                   d2r-world), and every talk is reported in d2r-quest-talk.txt
//   test_spawn=<class>              test only: spawn this NPC next to the player in town
//   test_cursor=1                   test only: mouse position and left button from d2r-npc-cursor.txt

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
#include <cstring>
#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace {

const D2RL::PluginInfo Info{
    .infoSize = D2RL::PluginInfoSize,
    .apiVersion = D2RL_PLUGIN_API_VERSION,
    .id = "d2r-npc",
    .name = "Editor NPCs",
    .version = "0.1.0",
    .author = "D2R Level Editor",
    .description = "New NPCs from the D2R Level Editor: they talk, trade or repair like a chosen town NPC.",
    .flags = D2RL::PluginFlags::Shared | D2RL::PluginFlags::NativeHooks,
    .reserved = {},
};

constexpr std::uint32_t NpcTableRva = 0x237EA60;
constexpr int NpcTableCount = 0x2B;
constexpr int NpcRecordSize = 0x1C;

constexpr std::uint32_t GetRecordRva = 0x3971A0;
// xor r8d,r8d / lea r10,[rip+..] / mov ecx,r8d / mov r9,r10 (the original is never called)
constexpr std::array<std::uint8_t, 13> GetRecordBytes{0x45, 0x33, 0xC0, 0x4C, 0x8D, 0x15, 0xB6, 0x78, 0xFE, 0x01, 0x41, 0x8B, 0xC8};
constexpr std::uint32_t StockRva = 0x396800;
constexpr std::array<std::uint8_t, 15> StockBytes{0x48, 0x89, 0x5C, 0x24, 0x08, 0x48, 0x89, 0x74, 0x24, 0x10, 0x57, 0x48, 0x83, 0xEC, 0x20};
constexpr std::uint32_t UpdateRva = 0x408670;
constexpr std::array<std::uint8_t, 12> UpdateBytes{0x40, 0x55, 0x57, 0x41, 0x55, 0x48, 0x8B, 0xEC, 0x48, 0x83, 0xEC, 0x70};

using GetRecordFn = void*(__fastcall*)(std::uint64_t version, int cls);
using StockFn = void*(__fastcall*)(std::uint64_t tables, int xpac, int cls, int difficulty);
using UpdateFn = void(__fastcall*)(void* game);
using GetServerUnitFn = void*(__fastcall*)(void* game, std::uint32_t type, std::uint32_t guid);
using UnitFn = void*(__fastcall*)(void* unit);
using CoordsFn = std::uint64_t(__fastcall*)(void* unit);
using LevelIdFn = int(__fastcall*)(void* room);
using FindRoomFn = void*(__fastcall*)(void* room, int x, int y);
using SpawnFn = void*(__fastcall*)(void* game, void* room, int x, int y, int cls, int mode, int a7, std::uint16_t flags);

GetRecordFn OrigGetRecord = nullptr;
StockFn OrigStock = nullptr;
UpdateFn OrigUpdate = nullptr;
std::uintptr_t Base = 0;
GetServerUnitFn GetServerUnit = nullptr;
UnitFn GetRoom = nullptr;
CoordsFn GetCoords = nullptr;
LevelIdFn LevelIdOf = nullptr;
FindRoomFn FindRoom = nullptr;
SpawnFn Spawn = nullptr;
std::uint8_t* NpcTable = nullptr;
const D2RL::DataTableServiceV1* Tables = nullptr;
const D2RL::PluginContext* Ctx = nullptr;

std::map<int, std::uint16_t> Speech;  // class -> string id of what it says
std::map<int, std::map<int, std::uint16_t>> StageSpeech;  // class -> quest stage -> string id
std::map<int, int> BaseOf;                                 // new class -> town NPC class
std::map<int, std::array<std::uint8_t, NpcRecordSize>> Records;  // copies with the new class id
int TestSpawn = -1;
bool TestCursor = false;
bool TestUpdate = true;  // test_update=0: no per-frame hook (no dump), when another plugin needs it
bool TestSpawned = false;
std::uint32_t LastGuid = 0;
int LastCheck = -1;
std::string Dir;


void Log(const char* fmt, ...) {
    FILE* f = std::fopen((Dir + "\\d2r-npc.log").c_str(), "a");
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

void ReadConfig() {
    FILE* f = std::fopen((Dir + "\\d2r-npc.ini").c_str(), "r");
    if (!f) return;
    char line[1024];
    while (std::fgets(line, sizeof line, f)) {
        int a = 0, b = 0;
        if (std::sscanf(line, "npc=%d,%d", &a, &b) == 2) BaseOf[a] = b;
        if (std::sscanf(line, "test_spawn=%d", &a) == 1) TestSpawn = a;
        if (std::sscanf(line, "test_cursor=%d", &a) == 1) TestCursor = a != 0;
        if (std::sscanf(line, "test_update=%d", &a) == 1) TestUpdate = a != 0;
        if (std::sscanf(line, "speech=%d,%d", &a, &b) == 2) Speech[a] = static_cast<std::uint16_t>(b);
        int c = 0;
        if (std::sscanf(line, "speech_stage=%d,%d,%d", &a, &b, &c) == 3) StageSpeech[a][b] = static_cast<std::uint16_t>(c);
    }
    std::fclose(f);
}

std::uint8_t* TableRecord(int cls) {
    for (int i = 0; i < NpcTableCount; ++i) {
        std::uint8_t* r = NpcTable + i * NpcRecordSize;
        if (*reinterpret_cast<std::int16_t*>(r) == cls) return r;
    }
    return nullptr;
}

// Logging: every hook writes one line the first time it acts for a class (later calls are
// counted only), so the log shows what happened without growing every frame.
std::mutex LogMutex;
std::map<std::string, int> Seen;
bool First(const std::string& what) {
    std::lock_guard lock(LogMutex);
    return Seen[what]++ == 0;
}

void* __fastcall GetRecordDetour(std::uint64_t, int cls) {
    if (std::uint8_t* r = TableRecord(cls)) return r;
    const auto it = Records.find(cls);
    if (it == Records.end()) return nullptr;
    if (First("record" + std::to_string(cls)))
        Log("NPC record: class %d acts as town NPC %d (menu, trade)", cls, BaseOf[cls]);
    return it->second.data();
}

void* __fastcall StockDetour(std::uint64_t tables, int xpac, int cls, int difficulty) {
    const auto it = BaseOf.find(cls);
    if (it == BaseOf.end()) return OrigStock(tables, xpac, cls, difficulty);
    void* r = OrigStock(tables, xpac, it->second, difficulty);
    if (First("stock" + std::to_string(cls) + "/" + std::to_string(difficulty)))
        Log("vendor goods: class %d uses the goods of %d (difficulty %d): %s", cls, it->second, difficulty,
            r ? "found" : "none (that NPC sells nothing)");
    return r;
}

void PollTestAction();

void __fastcall UpdateDetour(void* game) {
    OrigUpdate(game);
    if (!game) return;
    if (const std::string dump = Dir + "\\d2r-npc-dump.txt"; GetFileAttributesA(dump.c_str()) != INVALID_FILE_ATTRIBUTES) {
        std::remove(dump.c_str());
        void* pl = nullptr;
        for (std::uint32_t g = 0; !pl && g < 16; ++g) pl = GetServerUnit(game, 0, g);
        if (pl) {
            const std::uint64_t pc = GetCoords(pl);
            Log("dump: player at %d,%d", static_cast<int>(pc & 0xFFFF), static_cast<int>((pc >> 16) & 0xFFFF));
        }
        if (Tables) {
            for (auto bank : {D2RL::DataTables::Bank::Classic, D2RL::DataTables::Bank::Lod, D2RL::DataTables::Bank::Rotw})
                for (auto id : {D2RL::DataTables::TableId::MonStats, D2RL::DataTables::TableId::MonPreset, D2RL::DataTables::TableId::Npc}) {
                    D2RL::DataTables::TableView v{};
                    v.structSize = D2RL::DataTables::TableViewSize;
                    const auto r = Tables->getTable(Ctx, bank, id, &v);
                    Log("dump: bank %u table %u: result %u rows %u size %u", static_cast<unsigned>(bank), static_cast<unsigned>(id),
                        static_cast<unsigned>(r), v.rowCount, v.rowSize);
                }
        }
        for (std::uint32_t g = 0; g < 4000; ++g) {
            void* u = GetServerUnit(game, 1, g);
            if (!u) continue;
            const int cls = *reinterpret_cast<int*>(static_cast<std::uint8_t*>(u) + 0x04);
            const std::uint64_t c = GetCoords(u);
            Log("dump: monster guid %u class %d at %d,%d", g, cls, static_cast<int>(c & 0xFFFF), static_cast<int>((c >> 16) & 0xFFFF));
        }
    }
    if (LastGuid && *reinterpret_cast<int*>(static_cast<std::uint8_t*>(game) + 0x170) == LastCheck) {
        void* u = GetServerUnit(game, 1, LastGuid);
        Log("2 s later: unit %u %s", LastGuid, u ? "exists" : "is gone");
        if (u) {
            const std::uint64_t c = GetCoords(u);
            Log("  at %d,%d mode %u", static_cast<int>(c & 0xFFFF), static_cast<int>((c >> 16) & 0xFFFF),
                *reinterpret_cast<std::uint32_t*>(static_cast<std::uint8_t*>(u) + 0x0C));
        }
    }
    // spawn when d2r-npc-spawn.txt appears ("<class> [dx dy]"), and once at frame 600
    const int frame = *reinterpret_cast<int*>(static_cast<std::uint8_t*>(game) + 0x170);
    int cls = -1, dx = 3, dy = 3;
    const std::string trigger = Dir + "\\d2r-npc-spawn.txt";
    if (FILE* f = std::fopen(trigger.c_str(), "r")) {
        std::fscanf(f, "%d %d %d", &cls, &dx, &dy);
        std::fclose(f);
        std::remove(trigger.c_str());
    } else if (!TestSpawned && TestSpawn >= 0 && frame >= 600) {
        cls = TestSpawn;
    }
    if (cls < 0) return;
    TestSpawned = true;
    void* player = nullptr;
    for (std::uint32_t g = 0; !player && g < 16; ++g) player = GetServerUnit(game, 0, g);
    void* room = player ? GetRoom(player) : nullptr;
    if (!room) return;
    const std::uint64_t c = GetCoords(player);
    const int px = static_cast<int>(c & 0xFFFF), py = static_cast<int>((c >> 16) & 0xFFFF);
    const int x = px + dx, y = py + dy;
    void* target = FindRoom(room, x, y);
    void* unit = target ? Spawn(game, target, x, y, cls, 1, -1, 0x80) : nullptr;
    const std::uint32_t guid = unit ? *reinterpret_cast<std::uint32_t*>(static_cast<std::uint8_t*>(unit) + 0x08) : 0;
    Log("test spawn of class %d at %d,%d (player %d,%d) in level %d: %s guid %u mode %u", cls, x, y, px, py, LevelIdOf(room),
        unit ? "ok" : "failed", guid, unit ? *reinterpret_cast<std::uint32_t*>(static_cast<std::uint8_t*>(unit) + 0x0C) : 0);
    LastGuid = guid;
    LastCheck = frame + 50;
}

// ---- test only (test_cursor=1): clicks without the real mouse, as in the World Waypoints test
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
        if (FILE* f = std::fopen((Dir + "\\d2r-npc-cursor.txt").c_str(), "r")) {
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


// ---- speech: an NPC of ours says its own text in the game's own speech window ----
// The client keeps the class of the NPC it talks to at RVA 0x2A48764 (npcmenu.cpp). Every speech
// (Introduction, Gossip, quest talk) goes through NPCMENU_Speak(unit, string id, done) at RVA
// 0x1980B0, which scrolls the string in the NPC window. For our NPCs the string id is replaced by
// the NPC's own string (written by the editor into the mod's npcs.json).
constexpr std::uint32_t TalkClassRva = 0x2A48764;
constexpr std::uint32_t SpeakRva = 0x1980B0;
// mov [rsp+20h],rbx / push rbp,rsi,rdi,r14,r15 / lea rbp,[rsp-220h]
constexpr std::array<std::uint8_t, 20> SpeakBytes{0x48, 0x89, 0x5C, 0x24, 0x20, 0x55, 0x56, 0x57, 0x41, 0x56,
                                                  0x41, 0x57, 0x48, 0x8D, 0xAC, 0x24, 0xE0, 0xFD, 0xFF, 0xFF};
using SpeakFn = void(__fastcall*)(void* unit, std::uint16_t stringId, void* done);
SpeakFn OrigSpeak = nullptr;


void __fastcall SpeakDetour(void* unit, std::uint16_t stringId, void* done) {
    const int cls = *reinterpret_cast<int*>(Base + TalkClassRva);
    const auto it = Speech.find(cls);
    if (const auto st = StageSpeech.find(cls); st != StageSpeech.end()) {
        int stage = 0;
        if (FILE* f = std::fopen((Dir + "\\d2r-quest-stage.txt").c_str(), "r")) {
            if (std::fscanf(f, "%d", &stage) != 1) stage = 0;
            std::fclose(f);
        }
        auto pick = st->second.upper_bound(stage);  // the text of the highest stage <= the current one
        if (pick != st->second.begin()) {
            --pick;
            Log("speech: NPC class %d at quest stage %d says string %u (text of stage %d)", cls, stage, pick->second, pick->first);
            if (FILE* f = std::fopen((Dir + "\\d2r-quest-talk.txt").c_str(), "w")) {
                std::fprintf(f, "%d\n", cls);
                std::fclose(f);
            }
            OrigSpeak(unit, pick->second, done);
            return;
        }
    }
    if (it != Speech.end()) {
        Log("speech: NPC class %d says string %u instead of %u", cls, it->second, stringId);
        stringId = it->second;
    } else if (BaseOf.count(cls)) {
        Log("speech: NPC class %d has no own text, keeps string %u", cls, stringId);
    }
    OrigSpeak(unit, stringId, done);
}

// ---- test actions (test_cursor=1): d2r-npc-action.txt "talk", "gossip" or "trade" runs that
// entry of the open NPC menu; the result shows in the log.
const D2RL::ThreadServiceV1* Threads = nullptr;
using MenuActionFn = std::uint64_t(__fastcall*)();

// Menu entries of the open NPC menu: Talk (0x1161E0, opens the talk list and selects the NPC's
// menu record), Gossip (0x113340), Trade (0x112C80, asks the server for the store: packet 0x38 mode 2).
std::string PendingAction;
void __cdecl RunAction(const D2RL::PluginContext*, void*) noexcept {
    const int cls = *reinterpret_cast<int*>(Base + TalkClassRva);
    Log("test action: %s with npc class %d", PendingAction.c_str(), cls);
    if (PendingAction == "talk") reinterpret_cast<MenuActionFn>(Base + 0x1161E0)();
    else if (PendingAction == "gossip") reinterpret_cast<MenuActionFn>(Base + 0x113340)();
    else if (PendingAction == "trade") reinterpret_cast<MenuActionFn>(Base + 0x112C80)();
}

DWORD WINAPI PollThread(LPVOID) {
    for (;;) {
        Sleep(100);
        PollTestAction();
    }
}

void PollTestAction() {
    const std::string path = Dir + "\\d2r-npc-action.txt";
    FILE* f = std::fopen(path.c_str(), "r");
    if (!f) return;
    char word[32]{};
    const int n = std::fscanf(f, "%31s", word);
    std::fclose(f);
    std::remove(path.c_str());
    if (n == 1 && Threads) {
        PendingAction = word;
        Threads->runOnUiThread(Ctx, RunAction, nullptr);
    }
}

// ---- test log of the UI (test_cursor=1): the in-game test reads it instead of screenshots ----
const D2RL::SharedEventServiceV1* Events = nullptr;
D2RL::SharedEvents::ListenerHandle Listener{};

D2RL::SharedEvents::UiMessageAction __cdecl OnUiMessage(const D2RL::PluginContext*, const D2RL::SharedEvents::UiMessageEvent* e, void*) noexcept {
    if (!e || e->structSize < D2RL::SharedEvents::UiMessageEventRequiredSize || !e->target || !e->command) return D2RL::SharedEvents::UiMessageAction::Continue;
    const bool panel = std::strcmp(e->target, "PanelManager") == 0 &&
                       (std::strcmp(e->command, "OpenPanel") == 0 || std::strcmp(e->command, "ClosePanel") == 0);
    if (panel || std::strcmp(e->target, "DialogMessage") == 0)
        Log("ui: %s:%s %s (npc class %d)", e->target, e->command, e->text ? e->text : "", *reinterpret_cast<int*>(Base + TalkClassRva));
    return D2RL::SharedEvents::UiMessageAction::Continue;
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
    Ctx = context;
    if (context->QueryService(D2RL::ServiceId::DataTable, 1, &Tables) != D2RL::ServiceQueryResult::Success) Tables = nullptr;
    const auto base = reinterpret_cast<std::uintptr_t>(GetModuleHandleW(nullptr));
    Base = base;
    NpcTable = reinterpret_cast<std::uint8_t*>(base + NpcTableRva);
    GetServerUnit = reinterpret_cast<GetServerUnitFn>(base + 0x48FE80);
    GetRoom = reinterpret_cast<UnitFn>(base + 0x34B440);
    GetCoords = reinterpret_cast<CoordsFn>(base + 0x34A110);
    LevelIdOf = reinterpret_cast<LevelIdFn>(base + 0x2EFC10);
    FindRoom = reinterpret_cast<FindRoomFn>(base + 0x38DFB0);
    Spawn = reinterpret_cast<SpawnFn>(base + 0x492CF0);
    for (const auto& [cls, from] : BaseOf) {
        const std::uint8_t* r = TableRecord(from);
        if (!r) {
            Log("npc %d: %d is not a town NPC", cls, from);
            continue;
        }
        auto& copy = Records[cls];
        std::memcpy(copy.data(), r, NpcRecordSize);
        *reinterpret_cast<std::int16_t*>(copy.data()) = static_cast<std::int16_t>(cls);
    }
    bool ok = context->InstallInlineHook(D2RL::MakeInlineHook(
        GetRecordRva, GetRecordBytes.data(), static_cast<std::uint32_t>(GetRecordBytes.size()),
        reinterpret_cast<void*>(&GetRecordDetour), reinterpret_cast<void**>(&OrigGetRecord)));
    const bool s = context->InstallInlineHook(D2RL::MakeInlineHook(
        StockRva, StockBytes.data(), static_cast<std::uint32_t>(StockBytes.size()),
        reinterpret_cast<void*>(&StockDetour), reinterpret_cast<void**>(&OrigStock)));
    const bool m = (Speech.empty() && StageSpeech.empty()) || context->InstallInlineHook(D2RL::MakeInlineHook(
        SpeakRva, SpeakBytes.data(), static_cast<std::uint32_t>(SpeakBytes.size()),
        reinterpret_cast<void*>(&SpeakDetour), reinterpret_cast<void**>(&OrigSpeak)));
    bool u = true;
    // the per-frame hook only for test spawns: other plugins (d2r-world) hook the same function, and
    // the test actions of test_cursor are polled from a thread instead
    if (TestSpawn >= 0 || (TestCursor && TestUpdate))
        u = context->InstallInlineHook(D2RL::MakeInlineHook(
            UpdateRva, UpdateBytes.data(), static_cast<std::uint32_t>(UpdateBytes.size()),
            reinterpret_cast<void*>(&UpdateDetour), reinterpret_cast<void**>(&OrigUpdate)));
    if (TestCursor) {
        if (context->QueryService(D2RL::ServiceId::Thread, 1, &Threads) != D2RL::ServiceQueryResult::Success) Threads = nullptr;
        if (context->QueryService(D2RL::ServiceId::SharedEvent, 1, &Events) == D2RL::ServiceQueryResult::Success) {
            const D2RL::SharedEvents::UiMessageListener l{D2RL::SharedEvents::UiMessageListenerSize, 0, 0, 0, OnUiMessage, nullptr};
            Events->registerUiMessageListener(context, &l, &Listener);
        }
        CreateThread(nullptr, 0, PollThread, nullptr, 0, nullptr);
        RedirectCursor("GetCursorPos");
        RedirectCursor("GetPhysicalCursorPos");
        if (HMODULE w = LoadLibraryW(L"win32u.dll")) {
            NtAsyncKey = reinterpret_cast<KeyFn>(GetProcAddress(w, "NtUserGetAsyncKeyState"));
            NtKey = reinterpret_cast<KeyFn>(GetProcAddress(w, "NtUserGetKeyState"));
        }
        if (NtAsyncKey) Redirect("GetAsyncKeyState", reinterpret_cast<const void*>(&TestGetAsyncKeyState));
        if (NtKey) Redirect("GetKeyState", reinterpret_cast<const void*>(&TestGetKeyState));
    }
    for (const auto& [cls, from] : BaseOf)
        Log("config: NPC class %d behaves like %d%s", cls, from, Speech.count(cls) ? ", has own speech" : "");
    Log("loaded: %zu NPCs, %zu with own speech; hooks record %d stock %d speech %d update %d", Records.size(),
        Speech.size(), ok, s, m, u);
    return ok && s;
}

D2RL_PLUGIN_EXPORT void D2RLoaderUnloadPlugin() noexcept {}
