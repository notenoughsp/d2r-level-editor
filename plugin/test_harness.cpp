// d2r-test-harness: unattended in-game test for editor mods. No mouse, keyboard or screenshots:
//   1. moves the game window to the configured rectangle (second monitor),
//   2. enters a game by posting Enter to its own window (character select -> Play),
//   3. on the server tick, once the player has settled, writes the server collision around
//      the player, the player position and the game seed to run_<n>.txt,
//   4. returns to the menu (D2RCore RequestActiveGameShutdown, called on the client frame),
//   5. repeats for `runs` games, writes done.txt and exits the process.
// Config: test-harness.ini next to the DLL (written with defaults on first start).
//
// RVAs: d2r-re catalog, D2RLoader 1.3.1-beta embedded game.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>
#include <audiopolicy.h>
#include <mmdeviceapi.h>

#include <D2RLPlugin/api.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdarg>
#include <string>
#include <utility>
#include <vector>

namespace {

constexpr std::uint32_t ProcessGameRva = 0x406550;  // GAME_ProcessGame(game), server thread
constexpr std::array<std::uint8_t, 9> ProcessGameBytes{0x48, 0x89, 0x74, 0x24, 0x20, 0x55, 0x57, 0x41, 0x57};
constexpr std::uint32_t DrawGameScreenRva = 0x93B40;  // CLIENT_DrawGameScreen(), main thread
constexpr std::array<std::uint8_t, 9> DrawGameScreenBytes{0x4C, 0x8B, 0xDC, 0x49, 0x89, 0x5B, 0x18, 0x56, 0x57};

const D2RL::PluginInfo Info{
    .infoSize = D2RL::PluginInfoSize,
    .apiVersion = D2RL_PLUGIN_API_VERSION,
    .id = "d2r-test-harness",
    .name = "Editor Test Harness",
    .version = "0.1.0",
    .author = "local",
    .description = "Unattended in-game test: enters games, logs collision and seed, exits.",
    .flags = D2RL::PluginFlags::Shared | D2RL::PluginFlags::NativeHooks,
    .reserved = {},
};

using VoidFn = void(__fastcall*)(void*);
using DrawFn = void(__cdecl*)();
using GetServerUnitFn = void*(__fastcall*)(void* game, int type, std::uint32_t guid);
using GetCoordsFn = std::uint64_t(__fastcall*)(void* unit);
using GetRoomFn = void*(__fastcall*)(void* unit);
using CheckMaskFn = std::uint32_t(__fastcall*)(void* room, int x, int y, std::uint16_t mask);
using BoolFn = bool(__cdecl*)();
using ShutdownFn = std::uint64_t(__cdecl*)();

VoidFn OrigProcessGame = nullptr;
DrawFn OrigDraw = nullptr;
GetServerUnitFn GetServerUnit = nullptr;
GetCoordsFn GetCoords = nullptr;
GetRoomFn GetRoom = nullptr;
CheckMaskFn CheckMask = nullptr;
BoolFn IsInGame = nullptr;
ShutdownFn RequestShutdown = nullptr;

struct Config {
    int startLevel = -1;      // start_level=1: bring the character to this level (town) before the first map log
    std::vector<int> levels;  // levels=1,2,3: lay out these levels and list their rooms (levels_<n>.txt)
    int runs = 3, radius = 150, settleTicks = 100;
    int wx = -3840, wy = 0, ww = 1600, wh = 900;
    int varySeed = 1;
    int play = 0;             // play=1: go there (moves.txt), then hand the game over to the player
    int testWindow = 0;       // test_window=1: in play mode still use the test monitor and mute (tests of play mode)
    int god = 0;              // god=1: players take no damage (act tests with a weak test character)
} Cfg;

// Movement test (moves.txt next to the DLL: one "x y" world subtile per line, run 0 only).
// CLIENT_UnitDoAction(action, unit, x, y) at RVA 0xFABE0 is what a click calls: it paths on the
// client and sends the move to the server. Action 1 = walk, 3 = run. The local player's client
// unit is CLIENT_GetPlayerUnit(index) (RVA 0x9A480) with the index at RVA 0x2A23704.
using DoActionFn = void(__fastcall*)(int action, void* unit, int x, int y);
using GetPlayerFn = void*(__fastcall*)(std::uint32_t index);
DoActionFn DoAction = nullptr;
GetPlayerFn GetClientPlayer = nullptr;
std::uint32_t* LocalPlayerIndex = nullptr;
// moves.txt commands: "x y" run to a world subtile, "r dx dy" run relative to the player,
// "dump" log collision + units at the current spot (explore_<k>.txt), "plan" dump, then create
// moves.wait and continue with the new moves.txt once the script removes it. If moves.wait exists next to
// the DLL, the driver waits until it is gone and reads moves.txt again (the test script can plan a
// route from run_0.txt first).
struct Move { char kind; int x, y; };
std::vector<Move> Moves;
std::atomic<int> DumpRequest{-1};   // explore dump index, done on the game thread
// "t x y": teleport there in hops, like the sorceress skill. SUNIT_Teleport(game, unit, room or null,
// x, y, exact, flag) at RVA 0x491CA0 is what the Teleport skill (0x554C40) calls on the server; it
// finds the target room near the unit's room, so long jumps go in hops of up to TeleportHop subtiles.
using TeleportFn = void(__fastcall*)(void* game, void* unit, void* room, int x, int y, int exact, int flag);
using FindRoomFn = void*(__fastcall*)(void* room, int x, int y);  // DUNGEON_FindRoomBySubtileCoords, RVA 0x38DFB0
FindRoomFn FindRoom = nullptr;
TeleportFn Teleport = nullptr;
constexpr int TeleportHop = 24;
std::atomic<long long> TeleportTarget{-1};
// "L id type": travel to another level like a waypoint. LEVEL_WarpUnit(game, unit, levelId, type)
// at RVA 0x488180 (Level.cpp; the waypoint object calls it with type 0, towns use 0xD). In the same
// act it finds the target spot and teleports, otherwise it changes the act.
using WarpFn = void(__fastcall*)(void* game, void* unit, int levelId, int type);
WarpFn LevelWarp = nullptr;
std::atomic<long long> WarpRequest{-1};  // levelId << 32 | type
std::atomic<long long> MoveTarget{-1};   // packed x << 32 | y, executed on the main thread
std::atomic<int> ServerX{-1}, ServerY{-1};
std::atomic<std::uint32_t> ServerFlags{0};
std::atomic<int> ServerLevel{-1};
// The player's level origin (world subtiles): the smallest tile corner of its rooms (Room2 +0x60/+0x64).
// "T dx dy" teleports to origin + (dx, dy): the level editor's "Play here" knows only the place in
// the map, and the game places most levels anew in every game (levels.txt offsets of -1).
std::atomic<int> LevelOriginX{-1}, LevelOriginY{-1};
using LevelIdFn = int(__fastcall*)(void* room);  // DUNGEON_GetLevelIdFromRoom, RVA 0x2EFC10
LevelIdFn LevelIdOf = nullptr;

std::string Dir;
std::atomic<int> Run{0};            // index of the current/next run
std::atomic<bool> Dumped{false};    // current game dumped
std::atomic<bool> ExitRequested{false};
void* CurrentGame = nullptr;
bool StartWarped = false;
int SettledTicks = 0;

void Log(const char* fmt, ...) {
    FILE* f = std::fopen((Dir + "\\harness.log").c_str(), "a");
    if (!f) return;
    SYSTEMTIME t;
    GetLocalTime(&t);
    std::fprintf(f, "[%02d:%02d:%02d.%03d] ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    va_list a;
    va_start(a, fmt);
    std::vfprintf(f, fmt, a);
    va_end(a);
    std::fputc('\n', f);
    std::fclose(f);
}

void ReadConfig() {
    const std::string path = Dir + "\\test-harness.ini";
    FILE* f = std::fopen(path.c_str(), "r");
    if (!f) {
        if ((f = std::fopen(path.c_str(), "w"))) {
            std::fprintf(f, "runs=%d\nradius=%d\nsettle_ticks=%d\nwindow_x=%d\nwindow_y=%d\nwindow_w=%d\nwindow_h=%d\n",
                         Cfg.runs, Cfg.radius, Cfg.settleTicks, Cfg.wx, Cfg.wy, Cfg.ww, Cfg.wh);
            std::fclose(f);
        }
        return;
    }
    char line[128];
    while (std::fgets(line, sizeof line, f)) {
        int v = 0;
        if (std::sscanf(line, "runs=%d", &v) == 1) Cfg.runs = v;
        if (std::sscanf(line, "radius=%d", &v) == 1) Cfg.radius = v;
        if (std::sscanf(line, "settle_ticks=%d", &v) == 1) Cfg.settleTicks = v;
        if (std::sscanf(line, "window_x=%d", &v) == 1) Cfg.wx = v;
        if (std::sscanf(line, "window_y=%d", &v) == 1) Cfg.wy = v;
        if (std::sscanf(line, "window_w=%d", &v) == 1) Cfg.ww = v;
        if (std::sscanf(line, "window_h=%d", &v) == 1) Cfg.wh = v;
        if (std::sscanf(line, "vary_game_seed=%d", &v) == 1) Cfg.varySeed = v;
        if (std::sscanf(line, "start_level=%d", &v) == 1) Cfg.startLevel = v;
        if (std::sscanf(line, "play=%d", &v) == 1) Cfg.play = v;
        if (std::sscanf(line, "test_window=%d", &v) == 1) Cfg.testWindow = v;
        if (std::sscanf(line, "god=%d", &v) == 1) Cfg.god = v;
        if (std::strncmp(line, "levels=", 7) == 0) {
            Cfg.levels.clear();
            for (char* t = std::strtok(line + 7, ", \r\n"); t; t = std::strtok(nullptr, ", \r\n")) Cfg.levels.push_back(std::atoi(t));
        }
    }
    std::fclose(f);
}

// Units in the player's room and its neighbours (RVAs from the Pickit contract / d2r-re catalog):
// RoomNeighbours(room, &rooms, &count) 0x2EFDE0, RoomFirstUnit(room) 0x2EFD90, NextUnit(unit) 0x34B4A0,
// UNITS_GetUnitType 0x34B9D0, UNITS_GetClassId(unit, file, line) 0x349860.
using NeighboursFn = void(__fastcall*)(void* room, void*** rooms, std::uint32_t* count);
using UnitFn = void*(__fastcall*)(void* unit);
using TypeFn = int(__fastcall*)(void* unit);
using ClassFn = int(__fastcall*)(void* unit, const char* file, int line);
NeighboursFn RoomNeighbours = nullptr;
UnitFn RoomFirstUnit = nullptr, NextUnit = nullptr;
TypeFn UnitType = nullptr;
ClassFn UnitClass = nullptr;

void DumpUnits(void* room, const char* path) {
    FILE* f = std::fopen(path, "w");
    if (!f) return;
    void** rooms = nullptr;
    std::uint32_t count = 0;
    RoomNeighbours(room, &rooms, &count);
    for (std::uint32_t r = 0; r < count && rooms; ++r) {
        for (void* u = RoomFirstUnit(rooms[r]); u; u = NextUnit(u)) {
            const std::uint64_t c = GetCoords(u);
            std::fprintf(f, "%d %d %d %d\n", UnitType(u), UnitClass(u, __FILE__, __LINE__),
                         static_cast<int>(c & 0xFFFF), static_cast<int>((c >> 16) & 0xFFFF));
        }
    }
    std::fclose(f);
}

// Whole-level layout without walking. From the player's room: Room1+0x18 = Room2, Room2+0x90 = level,
// level+0x1C8 = DRLG. DRLG_GetLevel(version, drlg, id) 0x3267C0 finds or allocates a level,
// DRLG_InitLevel(version, level) 0x3271C0 builds its rooms (the game does this lazily when a
// neighbour room needs it). Version = game+0x106. Level: +0x00 type (1 maze, 2 preset, 3 outdoor),
// +0x10 first Room2, +0x1F8 id. Room2: +0x48 next, +0x50 flags, +0x60/+0x64 tile x/y, +0x68/+0x6C size.
using GetLevelFn = void*(__fastcall*)(std::uint8_t version, void* drlg, int id);
using InitLevelFn = void(__fastcall*)(std::uint8_t version, void* level);
GetLevelFn GetLevel = nullptr;
InitLevelFn InitLevel = nullptr;

void DumpLevels(void* game, void* player, int index) {
    void* room1 = GetRoom(player);
    if (!room1 || Cfg.levels.empty()) return;
    auto* room2 = *reinterpret_cast<std::uint8_t**>(static_cast<std::uint8_t*>(room1) + 0x18);
    auto* level = room2 ? *reinterpret_cast<std::uint8_t**>(room2 + 0x90) : nullptr;
    void* drlg = level ? *reinterpret_cast<void**>(level + 0x1C8) : nullptr;
    if (!drlg) return;
    const std::uint8_t version = *(static_cast<std::uint8_t*>(game) + 0x106);
    char name[64];
    std::snprintf(name, sizeof name, "\\levels_%d.txt", index);
    FILE* f = std::fopen((Dir + name).c_str(), "w");
    if (!f) return;
    for (int id : Cfg.levels) {
        auto* lv = static_cast<std::uint8_t*>(GetLevel(version, drlg, id));
        if (!lv) continue;
        if (*reinterpret_cast<void**>(lv + 0x10) == nullptr) InitLevel(version, lv);
        std::fprintf(f, "L %d type %d\n", *reinterpret_cast<int*>(lv + 0x1F8), *reinterpret_cast<int*>(lv));
        int n = 0;
        for (auto* r = *reinterpret_cast<std::uint8_t**>(lv + 0x10); r && n < 4000; r = *reinterpret_cast<std::uint8_t**>(r + 0x48), ++n) {
            auto i32 = [&](int o) { return *reinterpret_cast<int*>(r + o); };
            std::fprintf(f, "R %d %d %d %d %08X", i32(0x60), i32(0x64), i32(0x68), i32(0x6C), i32(0x50));
            for (int o = 0; o < 0x100; o += 8) std::fprintf(f, " %llX", *reinterpret_cast<unsigned long long*>(r + o));
            std::fputc('\n', f);
        }
    }
    std::fclose(f);
    Log("levels %d dumped (%zu levels)", index, Cfg.levels.size());
}

void DumpRun(void* game, void* player, const char* prefix = "run", int index = -1) {
    if (index < 0) index = Run.load();
    const std::uint64_t c = GetCoords(player);
    const int px = static_cast<int>(c & 0xFFFF), py = static_cast<int>((c >> 16) & 0xFFFF);
    void* room = GetRoom(player);
    if (!room) return;
    char name[64];
    std::snprintf(name, sizeof name, "\\%s_%d.txt", prefix, index);
    FILE* f = std::fopen((Dir + name).c_str(), "w");
    if (!f) return;
    const std::uint32_t seed = *reinterpret_cast<std::uint32_t*>(static_cast<std::uint8_t*>(game) + 0x12C);
    const int r = Cfg.radius;
    std::fprintf(f, "seed %u\nplayer %d %d\norigin %d %d\nsize %d %d\n", seed, px, py, px - r, py - r, 2 * r + 1, 2 * r + 1);
    std::string line;
    for (int y = py - r; y <= py + r; ++y) {
        line.clear();
        for (int x = px - r; x <= px + r; ++x) {
            const std::uint32_t m = CheckMask(room, x, y, 0xFFFF);
            line += (m == 0x27) ? ' ' : (m & 1) ? '#' : '.';
        }
        std::fprintf(f, "%s\n", line.c_str());
    }
    std::fclose(f);
    std::snprintf(name, sizeof name, "\\%s_%d.txt", std::strcmp(prefix, "run") ? "explore_units" : "units", index);
    DumpUnits(room, (Dir + name).c_str());
    Log("%s %d dumped: seed %u player (%d,%d)", prefix, index, seed, px, py);
}

// UNITS_IsDeadOrBusy at RVA 0x34C2C0: a player in mode death/dead (or flag 0x10000) counts as busy.
using UnitBoolFn = int(__fastcall*)(void* unit);
UnitBoolFn IsDeadOrBusy = nullptr;

// god=1: SUNITDMG_ApplyDamage(game, attacker, defender, damage) at RVA 0x44A9B0 does nothing when the
// defender is a player, so the weak test character survives an act test with monsters.
constexpr std::uint32_t ApplyDamageRva = 0x44A9B0;
constexpr std::array<std::uint8_t, 16> ApplyDamageBytes{0x40, 0x53, 0x55, 0x57, 0x41, 0x56, 0x48, 0x81, 0xEC,
                                                        0x88, 0x00, 0x00, 0x00, 0x49, 0x8B, 0xD9};
using ApplyDamageFn = void(__fastcall*)(void* game, void* attacker, void* defender, void* damage);
ApplyDamageFn OrigApplyDamage = nullptr;

void __fastcall ApplyDamageDetour(void* game, void* attacker, void* defender, void* damage) {
    if (defender && *static_cast<int*>(defender) == 0) return;  // unit type 0 = player
    OrigApplyDamage(game, attacker, defender, damage);
}

void TrackServerPlayer(void* game);

void __fastcall ProcessGameDetour(void* game) {
    OrigProcessGame(game);
    if (game) TrackServerPlayer(game);
    if (game && WarpRequest.load() >= 0) {
        const long long w = WarpRequest.exchange(-1);
        for (std::uint32_t guid = 0; guid < 16; ++guid) {
            if (void* player = GetServerUnit(game, 0, guid)) {
                // A dead player is not warped: the client ignores the new position of a dead unit, so
                // it stays in the old level, and the next warp crashes it ("Could not get act!").
                if (IsDeadOrBusy(player)) {
                    Log("warp to level %d skipped: the player is dead in level %d", static_cast<int>(w >> 32), ServerLevel.load());
                    break;
                }
                Log("warp to level %d type %d", static_cast<int>(w >> 32), static_cast<int>(w & 0xFFFFFFFF));
                LevelWarp(game, player, static_cast<int>(w >> 32), static_cast<int>(w & 0xFFFFFFFF));
                break;
            }
        }
    }
    if (game && TeleportTarget.load() >= 0) {
        const long long t = TeleportTarget.exchange(-1);
        for (std::uint32_t guid = 0; guid < 16; ++guid) {
            if (void* player = GetServerUnit(game, 0, guid)) {
                const int tx = static_cast<int>(t >> 32), ty = static_cast<int>(t & 0xFFFFFFFF);
                void* here = GetRoom(player);
                if (here && FindRoom(here, tx, ty)) Teleport(game, player, nullptr, tx, ty, 0, 0);
                else Log("teleport to (%d,%d) skipped: no room there", tx, ty);
                break;
            }
        }
    }
    if (game && DumpRequest.load() >= 0) {
        for (std::uint32_t guid = 0; guid < 16; ++guid) {
            if (void* player = GetServerUnit(game, 0, guid)) {
                DumpRun(game, player, "explore", DumpRequest.load());
                break;
            }
        }
        DumpRequest = -1;
    }
    if (!game || Dumped.load() || Run.load() >= Cfg.runs) return;
    if (game != CurrentGame) {
        CurrentGame = game;
        SettledTicks = 0;
        StartWarped = false;
    }
    if (++SettledTicks < Cfg.settleTicks) return;
    for (std::uint32_t guid = 0; guid < 16; ++guid) {
        if (void* player = GetServerUnit(game, 0, guid)) {
            // A test needs a known start: the character may have been saved in another act or area.
            if (Cfg.startLevel >= 0 && ServerLevel.load() != Cfg.startLevel && !StartWarped) {
                StartWarped = true;
                Log("run %d: player in level %d, warp to start level %d", Run.load(), ServerLevel.load(), Cfg.startLevel);
                LevelWarp(game, player, Cfg.startLevel, 13);  // 13 = town start, as the waypoint uses for towns
                SettledTicks = 0;
                return;
            }
            DumpRun(game, player);
            DumpLevels(game, player, Run.load());
            Dumped = true;
            return;
        }
    }
}

// Server act setup: GAME_InitAct(game, act) passes game+0x12C (the game's map seed) to
// DUNGEON_AllocAct. Writing a different seed per run first lets the test show that the
// fixed-seed plugin, not the character save, decides the map.
using InitActFn = void(__fastcall*)(void* game, std::uint8_t act);
InitActFn OrigInitAct = nullptr;
constexpr std::uint32_t InitActRva = 0x48AA50;
constexpr std::array<std::uint8_t, 10> InitActBytes{0x48, 0x89, 0x5C, 0x24, 0x18, 0x48, 0x89, 0x6C, 0x24, 0x20};

void __fastcall InitActDetour(void* game, std::uint8_t act) {
    if (game && Cfg.varySeed) {
        auto* seed = reinterpret_cast<std::uint32_t*>(static_cast<std::uint8_t*>(game) + 0x12C);
        const std::uint32_t replaced = 0x9E3779B9u * static_cast<std::uint32_t>(Run.load() + 1) ^ 0x2545F491u;
        Log("run %d act %u: game seed %u replaced by %u", Run.load(), act, *seed, replaced);
        *seed = replaced;
    }
    OrigInitAct(game, act);
}

void TrackServerPlayer(void* game) {
    for (std::uint32_t guid = 0; guid < 16; ++guid) {
        if (void* player = GetServerUnit(game, 0, guid)) {
            const std::uint64_t c = GetCoords(player);
            const int px = static_cast<int>(c & 0xFFFF), py = static_cast<int>((c >> 16) & 0xFFFF);
            ServerX = px;
            ServerY = py;
            if (void* room = GetRoom(player)) {
                ServerFlags = CheckMask(room, px, py, 0xFFFF);
                ServerLevel = LevelIdOf(room);
                auto* room2 = *reinterpret_cast<std::uint8_t**>(static_cast<std::uint8_t*>(room) + 0x18);
                auto* level = room2 ? *reinterpret_cast<std::uint8_t**>(room2 + 0x90) : nullptr;
                if (level) {
                    int mx = INT32_MAX, my = INT32_MAX, n = 0;
                    for (auto* r = *reinterpret_cast<std::uint8_t**>(level + 0x10); r && n < 4000; r = *reinterpret_cast<std::uint8_t**>(r + 0x48), ++n) {
                        mx = (std::min)(mx, *reinterpret_cast<int*>(r + 0x60));
                        my = (std::min)(my, *reinterpret_cast<int*>(r + 0x64));
                    }
                    if (n) { LevelOriginX = mx * 5; LevelOriginY = my * 5; }
                }
            }
            return;
        }
    }
}

void __cdecl DrawDetour() {
    OrigDraw();
    const long long t = MoveTarget.exchange(-1);
    if (t >= 0 && DoAction && GetClientPlayer && LocalPlayerIndex) {
        if (void* me = GetClientPlayer(*LocalPlayerIndex)) {
            DoAction(3, me, static_cast<int>(t >> 32), static_cast<int>(t & 0xFFFFFFFF));
        }
    }
    if (ExitRequested.exchange(false) && RequestShutdown) {
        Log("run %d: leaving game", Run.load());
        RequestShutdown();
    }
}

HWND FindOwnWindow() {
    struct Ctx { DWORD pid; HWND hwnd; } ctx{GetCurrentProcessId(), nullptr};
    EnumWindows([](HWND h, LPARAM p) -> BOOL {
        auto* c = reinterpret_cast<Ctx*>(p);
        DWORD pid = 0;
        GetWindowThreadProcessId(h, &pid);
        if (pid == c->pid && IsWindowVisible(h) && GetWindow(h, GW_OWNER) == nullptr) {
            c->hwnd = h;
            return FALSE;
        }
        return TRUE;
    }, reinterpret_cast<LPARAM>(&ctx));
    return ctx.hwnd;
}

// Mutes every audio session of this process (Windows Core Audio). Other programs are untouched.
void MuteOwnAudio() {
    static bool logged = false;
    IMMDeviceEnumerator* en = nullptr;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en)))) return;
    IMMDevice* dev = nullptr;
    IAudioSessionManager2* mgr = nullptr;
    IAudioSessionEnumerator* list = nullptr;
    int muted = 0;
    if (SUCCEEDED(en->GetDefaultAudioEndpoint(eRender, eConsole, &dev)) &&
        SUCCEEDED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&mgr))) &&
        SUCCEEDED(mgr->GetSessionEnumerator(&list))) {
        int n = 0;
        list->GetCount(&n);
        for (int i = 0; i < n; ++i) {
            IAudioSessionControl* ctl = nullptr;
            IAudioSessionControl2* ctl2 = nullptr;
            ISimpleAudioVolume* vol = nullptr;
            DWORD pid = 0;
            if (SUCCEEDED(list->GetSession(i, &ctl)) &&
                SUCCEEDED(ctl->QueryInterface(IID_PPV_ARGS(&ctl2))) && SUCCEEDED(ctl2->GetProcessId(&pid)) &&
                pid == GetCurrentProcessId() && SUCCEEDED(ctl->QueryInterface(IID_PPV_ARGS(&vol)))) {
                vol->SetMute(TRUE, nullptr);
                ++muted;
            }
            if (vol) vol->Release();
            if (ctl2) ctl2->Release();
            if (ctl) ctl->Release();
        }
    }
    if (list) list->Release();
    if (mgr) mgr->Release();
    if (dev) dev->Release();
    en->Release();
    if (muted && !logged) {
        Log("audio muted (%d session(s))", muted);
        logged = true;
    }
}

void PostKey(HWND h, UINT vk) {
    const UINT scan = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC);
    // arrow keys are extended keys (lParam bit 24); the menu ignores them without it
    const UINT ext = (vk == VK_UP || vk == VK_DOWN || vk == VK_LEFT || vk == VK_RIGHT) ? (1u << 24) : 0;
    PostMessageW(h, WM_KEYDOWN, vk, 1 | (scan << 16) | ext);
    Sleep(60);
    PostMessageW(h, WM_KEYUP, vk, 1 | (scan << 16) | ext | (1u << 30) | (1u << 31));
}

void ReadMoves() {
    Moves.clear();
    FILE* mf = std::fopen((Dir + "\\moves.txt").c_str(), "r");
    if (!mf) return;
    char line[128];
    while (std::fgets(line, sizeof line, mf)) {
        int a, b;
        if (std::sscanf(line, " r %d %d", &a, &b) == 2) Moves.push_back({'r', a, b});
        else if (std::sscanf(line, " t %d %d", &a, &b) == 2) Moves.push_back({'t', a, b});
        else if (std::sscanf(line, " T %d %d", &a, &b) == 2) Moves.push_back({'T', a, b});
        else if (std::sscanf(line, " w %d", &a) == 1) Moves.push_back({'w', a, 0});
        else if (std::sscanf(line, " L %d %d", &a, &b) == 2) Moves.push_back({'L', a, b});
        else if (std::strncmp(line, "dump", 4) == 0) Moves.push_back({'d', 0, 0});
        else if (std::strncmp(line, "plan", 4) == 0) Moves.push_back({'p', 0, 0});
        else if (std::sscanf(line, "%d %d", &a, &b) == 2) Moves.push_back({'a', a, b});
    }
    std::fclose(mf);
}

DWORD WINAPI Driver(LPVOID) {
    HWND h = nullptr;
    for (int i = 0; i < 600 && !h; ++i, Sleep(100)) h = FindOwnWindow();
    if (!h) {
        Log("no game window found");
        return 0;
    }
    Log("window %p found", h);
    bool wasInGame = false, placedLogged = false, leaving = false;
    DWORD lastEnter = 0, lastPlace = 0, lastMute = 0, start = GetTickCount();
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    while (true) {
        const DWORD now = GetTickCount();
        if ((!Cfg.play || Cfg.testWindow) && now - lastPlace > 2000) {  // keep the window on the test monitor (the game may resize it at start)
            RECT rc;
            GetWindowRect(h, &rc);
            if (rc.left != Cfg.wx || rc.top != Cfg.wy || rc.right - rc.left != Cfg.ww || rc.bottom - rc.top != Cfg.wh)
                SetWindowPos(h, nullptr, Cfg.wx, Cfg.wy, Cfg.ww, Cfg.wh, SWP_NOZORDER | SWP_NOACTIVATE);
            else if (!placedLogged) {
                Log("window at %d,%d size %dx%d", rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top);
                placedLogged = true;
            }
            lastPlace = now;
        }
        const bool inGame = IsInGame && IsInGame();
        if (inGame && Dumped.load() && !ExitRequested.load() && !leaving) {
            if (Run.load() == 0 && GetFileAttributesA((Dir + "\\moves.wait").c_str()) != INVALID_FILE_ATTRIBUTES) {
                Log("waiting for moves.txt");
                for (int i = 0; i < 1200 && GetFileAttributesA((Dir + "\\moves.wait").c_str()) != INVALID_FILE_ATTRIBUTES; ++i) Sleep(100);
                ReadMoves();
                Log("moves read: %zu", Moves.size());
            }
            if (Run.load() == 0 && !Moves.empty()) {
                int dumps = 0;
                for (size_t i = 0; i < Moves.size(); ++i) {
                    const Move m = Moves[i];
                    if (m.kind == 'd' || m.kind == 'p') {
                        DumpRequest = dumps;
                        for (int k = 0; k < 100 && DumpRequest.load() >= 0; ++k) Sleep(50);
                        ++dumps;
                        if (m.kind == 'p') {
                            const std::string wait = Dir + "\\moves.wait";
                            if (FILE* wf = std::fopen(wait.c_str(), "w")) std::fclose(wf);
                            for (int k = 0; k < 1200 && GetFileAttributesA(wait.c_str()) != INVALID_FILE_ATTRIBUTES; ++k) Sleep(100);
                            ReadMoves();
                            Log("plan %d: %zu new moves", dumps - 1, Moves.size());
                            i = static_cast<size_t>(-1);
                        }
                        continue;
                    }
                    if (m.kind == 'L') {
                        WarpRequest = (static_cast<long long>(m.x) << 32) | static_cast<unsigned>(m.y);
                        Sleep(4000);
                        Log("after warp: player (%d,%d) in level %d", ServerX.load(), ServerY.load(), ServerLevel.load());
                        continue;
                    }
                    if (m.kind == 'w') {  // "w ms": wait
                        Sleep(static_cast<DWORD>(m.x));
                        continue;
                    }
                    if (m.kind == 'T') {  // relative to the level origin: becomes a 't' move
                        Log("level %d origin (%d,%d)", ServerLevel.load(), LevelOriginX.load(), LevelOriginY.load());
                        Moves[i] = {'t', LevelOriginX.load() + m.x, LevelOriginY.load() + m.y};
                        --i;
                        continue;
                    }
                    if (m.kind == 't') {
                        const int sx0 = ServerX.load(), sy0 = ServerY.load();
                        int stuck = 0, hops = 0;
                        while (hops < 200 && stuck < 3) {
                            const int sx = ServerX.load(), sy = ServerY.load();
                            const int dx = m.x - sx, dy = m.y - sy;
                            const int dist = std::max(std::abs(dx), std::abs(dy));
                            if (dist <= 2) break;
                            const int step = std::min(dist, TeleportHop);
                            const int tx = sx + dx * step / dist, ty = sy + dy * step / dist;
                            TeleportTarget = (static_cast<long long>(tx) << 32) | static_cast<unsigned>(ty);
                            Sleep(60);
                            int k = 0;
                            while (k < 20 && ServerX.load() == sx && ServerY.load() == sy) { Sleep(25); ++k; }
                            stuck = (ServerX.load() == sx && ServerY.load() == sy) ? stuck + 1 : 0;
                            ++hops;
                        }
                        Log("teleport %zu from (%d,%d) target (%d,%d) ended (%d,%d) in %d hops",
                            i, sx0, sy0, m.x, m.y, ServerX.load(), ServerY.load(), hops);
                        continue;
                    }
                    const int sx = ServerX.load(), sy = ServerY.load();
                    const int mx = m.kind == 'r' ? sx + m.x : m.x, my = m.kind == 'r' ? sy + m.y : m.y;
                    MoveTarget = (static_cast<long long>(mx) << 32) | static_cast<unsigned>(my);
                    // wait until the player stops (at most about 8 s)
                    Sleep(600);
                    int lx = -1, ly = -1, still = 0;
                    for (int k = 0; k < 40 && still < 3; ++k) {
                        Sleep(200);
                        const int cx = ServerX.load(), cy = ServerY.load();
                        still = (cx == lx && cy == ly) ? still + 1 : 0;
                        lx = cx;
                        ly = cy;
                    }
                    Log("move %zu from (%d,%d) target (%d,%d) ended (%d,%d) flags 0x%X",
                        i, sx, sy, mx, my, ServerX.load(), ServerY.load(), ServerFlags.load());
                }
            }
            if (Cfg.play) {  // the player takes over: no more input, no leaving, no exit
                Log("play mode: arrived at (%d,%d) in level %d, handing over", ServerX.load(), ServerY.load(), ServerLevel.load());
                if (FILE* f = std::fopen((Dir + "\\arrived.txt").c_str(), "w")) std::fclose(f);
                return 0;
            }
            leaving = true;
            ExitRequested = true;
        }
        if (!inGame) leaving = false;
        if (wasInGame && !inGame) {  // back in the menu after a run
            Log("run %d: back in menu", Run.load());
            Run += 1;
            Dumped = false;
            CurrentGame = nullptr;
            if (Run.load() >= Cfg.runs) {
                FILE* f = std::fopen((Dir + "\\done.txt").c_str(), "w");
                if (f) {
                    std::fprintf(f, "runs %d\n", Cfg.runs);
                    std::fclose(f);
                }
                Log("all runs done, exiting");
                Sleep(500);
                ExitProcess(0);
            }
        }
        wasInGame = inGame;
        if ((!Cfg.play || Cfg.testWindow) && now - lastMute > 3000) {  // the game creates its audio session late: keep it muted
            MuteOwnAudio();
            lastMute = now;
        }
        if (!inGame && now - lastEnter > 4000 && now - start > 8000) {  // character select: Enter = Play
            // The character menu reacts to a posted Enter but ignores posted arrow keys and clicks,
            // so every run uses the selected character; InitActDetour varies the game seed instead.
            PostKey(h, VK_RETURN);
            lastEnter = now;
        }
        if (now - start > 15 * 60 * 1000) {
            Log("timeout, exiting");
            ExitProcess(2);
        }
        Sleep(250);
    }
}

}  // namespace

D2RL_PLUGIN_EXPORT auto D2RLoaderGetPluginInfo() noexcept -> const D2RL::PluginInfo* { return &Info; }

D2RL_PLUGIN_EXPORT auto D2RLoaderLoadPlugin(const D2RL::PluginContext* context) noexcept -> bool {
    if (!D2RL::HasContext(context) || context->apiVersion < D2RL_PLUGIN_API_VERSION) return false;
    char path[MAX_PATH]{};
    HMODULE self{};
    GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       reinterpret_cast<LPCSTR>(&Driver), &self);
    GetModuleFileNameA(self, path, MAX_PATH);
    Dir = std::string(path).substr(0, std::string(path).find_last_of("\\/"));
    ReadConfig();
    ReadMoves();
    Log("harness loaded: runs %d radius %d moves %zu", Cfg.runs, Cfg.radius, Moves.size());

    const auto base = reinterpret_cast<std::uintptr_t>(GetModuleHandleW(nullptr));
    GetServerUnit = reinterpret_cast<GetServerUnitFn>(base + 0x48FE80);
    GetCoords = reinterpret_cast<GetCoordsFn>(base + 0x34A110);
    GetRoom = reinterpret_cast<GetRoomFn>(base + 0x34B440);
    CheckMask = reinterpret_cast<CheckMaskFn>(base + 0x366250);
    DoAction = reinterpret_cast<DoActionFn>(base + 0xFABE0);
    RoomNeighbours = reinterpret_cast<NeighboursFn>(base + 0x2EFDE0);
    RoomFirstUnit = reinterpret_cast<UnitFn>(base + 0x2EFD90);
    NextUnit = reinterpret_cast<UnitFn>(base + 0x34B4A0);
    UnitType = reinterpret_cast<TypeFn>(base + 0x34B9D0);
    UnitClass = reinterpret_cast<ClassFn>(base + 0x349860);
    GetLevel = reinterpret_cast<GetLevelFn>(base + 0x3267C0);
    Teleport = reinterpret_cast<TeleportFn>(base + 0x491CA0);
    FindRoom = reinterpret_cast<FindRoomFn>(base + 0x38DFB0);
    LevelWarp = reinterpret_cast<WarpFn>(base + 0x488180);
    LevelIdOf = reinterpret_cast<LevelIdFn>(base + 0x2EFC10);
    InitLevel = reinterpret_cast<InitLevelFn>(base + 0x3271C0);
    GetClientPlayer = reinterpret_cast<GetPlayerFn>(base + 0x9A480);
    LocalPlayerIndex = reinterpret_cast<std::uint32_t*>(base + 0x2A23704);
    if (HMODULE core = GetModuleHandleW(L"D2RCore.dll")) {
        IsInGame = reinterpret_cast<BoolFn>(GetProcAddress(core, "IsInGame"));
        RequestShutdown = reinterpret_cast<ShutdownFn>(GetProcAddress(core, "RequestActiveGameShutdown"));
    }
    Log("IsInGame %p RequestActiveGameShutdown %p", IsInGame, RequestShutdown);

    const bool a = context->InstallInlineHook(D2RL::MakeInlineHook(
        ProcessGameRva, ProcessGameBytes.data(), static_cast<std::uint32_t>(ProcessGameBytes.size()),
        reinterpret_cast<void*>(&ProcessGameDetour), reinterpret_cast<void**>(&OrigProcessGame)));
    const bool b = context->InstallInlineHook(D2RL::MakeInlineHook(
        DrawGameScreenRva, DrawGameScreenBytes.data(), static_cast<std::uint32_t>(DrawGameScreenBytes.size()),
        reinterpret_cast<void*>(&DrawDetour), reinterpret_cast<void**>(&OrigDraw)));
    const bool c = context->InstallInlineHook(D2RL::MakeInlineHook(
        InitActRva, InitActBytes.data(), static_cast<std::uint32_t>(InitActBytes.size()),
        reinterpret_cast<void*>(&InitActDetour), reinterpret_cast<void**>(&OrigInitAct)));
    IsDeadOrBusy = reinterpret_cast<UnitBoolFn>(base + 0x34C2C0);
    if (Cfg.god) {
        const bool g = context->InstallInlineHook(D2RL::MakeInlineHook(
            ApplyDamageRva, ApplyDamageBytes.data(), static_cast<std::uint32_t>(ApplyDamageBytes.size()),
            reinterpret_cast<void*>(&ApplyDamageDetour), reinterpret_cast<void**>(&OrigApplyDamage)));
        Log("god mode: damage hook %d", g);
    }
    Log("hooks: process game %d, draw %d, init act %d", a, b, c);
    if (!a || !b || !c || !IsInGame) {
        D2RL::LogError(context, "Editor Test Harness: setup failed, see harness.log");
        return false;
    }
    CloseHandle(CreateThread(nullptr, 0, Driver, nullptr, 0, nullptr));
    return true;
}

D2RL_PLUGIN_EXPORT void D2RLoaderUnloadPlugin() noexcept {}
