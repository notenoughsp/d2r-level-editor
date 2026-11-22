// d2r-survival: D2RLoader plugin for a wave survival mode. Outside the towns, monsters come in
// waves around the players; every wave is larger than the one before.
//
// Server hooks and functions (D2RLoader 1.3.1-beta embedded game, see d2r-re catalog):
//   0x408670  per-game server update, called once per frame from GAME_ProcessGame (game+0x170 =
//             frame counter, 25 frames per second). Hooked here.
//   0x48FE80  SUNIT_GetServerUnit(game, type, guid)
//   0x34B440  UNITS_GetRoom(unit), 0x34A110 UNITS_GetCoords(unit) (x | y << 16)
//   0x2EFC10  DUNGEON_GetLevelIdFromRoom(room), 0x327850 DUNGEON_IsTownLevelId(id)
//   0x38DFB0  DUNGEON_FindRoomBySubtileCoords(room, x, y)
//   0x366250  COLLISION_CheckMask(room, x, y, mask): 0x27 = outside the map, bit 0 = blocks walking
//   0x492CF0  MONSTERSPAWN_SpawnMonster(game, room, x, y, class, mode 1, -1, 0x80): the call the
//             normal monster population uses; returns the unit
//   0x34C2C0  UNITS_IsDead(unit)
//   0x50ACF0  room monster population (monster region packs, champions, uniques), called from
//             GAME_PopulateActiveRoom; hooked to turn the normal monsters off outside the towns.
//             Preset units (act bosses, super uniques, NPCs) come from another function and stay.
//
// Config: d2r-survival.ini next to the DLL (the editor's export writes it with the monster lists
// of every level from levels.txt):
//   first_wave_seconds=6  break_seconds=8  wave_timeout_seconds=90
//   base_count=6  per_wave=3  max_alive=80  radius_min=10  radius_max=18  normal_monsters=0
//   level_<id>=<monstats row>,<row>,...
// State and wave log: d2r-survival.log next to the DLL.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>

#include <D2RLPlugin/api.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

namespace {

const D2RL::PluginInfo Info{
    .infoSize = D2RL::PluginInfoSize,
    .apiVersion = D2RL_PLUGIN_API_VERSION,
    .id = "d2r-survival",
    .name = "Wave Survival",
    .version = "0.1.0",
    .author = "local",
    .description = "Monsters come in growing waves around the players outside the towns.",
    .flags = D2RL::PluginFlags::Shared | D2RL::PluginFlags::NativeHooks,
    .reserved = {},
};

constexpr std::uint32_t UpdateRva = 0x408670;
constexpr std::array<std::uint8_t, 12> UpdateBytes{0x40, 0x55, 0x57, 0x41, 0x55, 0x48, 0x8B, 0xEC, 0x48, 0x83, 0xEC, 0x70};

using UpdateFn = void(__fastcall*)(void* game);
using GetServerUnitFn = void*(__fastcall*)(void* game, std::uint32_t type, std::uint32_t guid);
using UnitFn = void*(__fastcall*)(void* unit);
using CoordsFn = std::uint64_t(__fastcall*)(void* unit);
using LevelIdFn = int(__fastcall*)(void* room);
using IsTownFn = bool(__fastcall*)(int levelId);
using FindRoomFn = void*(__fastcall*)(void* room, int x, int y);
using CheckMaskFn = std::uint32_t(__fastcall*)(void* room, int x, int y, std::uint32_t mask);
using SpawnFn = void*(__fastcall*)(void* game, void* room, int x, int y, int cls, int mode, int a7, std::uint16_t flags);
using IsDeadFn = bool(__fastcall*)(void* unit);

UpdateFn OrigUpdate = nullptr;
using PopulateFn = void(__fastcall*)(void* game, void* room);
PopulateFn OrigPopulate = nullptr;
constexpr std::uint32_t PopulateRva = 0x50ACF0;
constexpr std::array<std::uint8_t, 12> PopulateBytes{0x4C, 0x8B, 0xDC, 0x53, 0x56, 0x48, 0x81, 0xEC, 0xB8, 0x00, 0x00, 0x00};
GetServerUnitFn GetServerUnit = nullptr;
UnitFn GetRoom = nullptr;
CoordsFn GetCoords = nullptr;
LevelIdFn LevelIdOf = nullptr;
IsTownFn IsTown = nullptr;
FindRoomFn FindRoom = nullptr;
CheckMaskFn CheckMask = nullptr;
SpawnFn Spawn = nullptr;
IsDeadFn IsDead = nullptr;
// Units around a room: RoomNeighbours(room, &rooms, &count) 0x2EFDE0, RoomFirstUnit(room) 0x2EFD90,
// UNITS_GetNextUnitInRoom(unit) 0x34B4A0, UNITS_GetUnitType(unit) 0x34B9D0.
using NeighboursFn = void(__fastcall*)(void* room, void*** rooms, std::uint32_t* count);
using TypeFn = int(__fastcall*)(void* unit);
NeighboursFn RoomNeighbours = nullptr;
UnitFn RoomFirstUnit = nullptr, NextUnit = nullptr;
TypeFn UnitType = nullptr;

struct Config {
    int firstWave = 6, breakSeconds = 8, waveTimeout = 90;
    int baseCount = 6, perWave = 3, maxAlive = 80, radiusMin = 10, radiusMax = 18;
    int normalMonsters = 0;
    std::map<int, std::vector<int>> levels;
} Cfg;

struct GameState {
    int wave = 0;
    int nextWaveFrame = -1;     // frame of the next wave, -1 = not scheduled
    int waveStartFrame = 0;
    int levelId = -1;
    std::vector<std::uint32_t> alive;  // GUIDs of this mode's monsters
};
std::map<void*, GameState> Games;

std::string Dir;
std::uint32_t Rng = 0x9E3779B9u;

std::uint32_t Rand() {
    Rng ^= Rng << 13;
    Rng ^= Rng >> 17;
    Rng ^= Rng << 5;
    return Rng;
}

void Log(const char* fmt, ...) {
    FILE* f = std::fopen((Dir + "\\d2r-survival.log").c_str(), "a");
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
    const std::string path = Dir + "\\d2r-survival.ini";
    FILE* f = std::fopen(path.c_str(), "r");
    if (!f) {
        if ((f = std::fopen(path.c_str(), "w"))) {
            std::fprintf(f, "first_wave_seconds=%d\nbreak_seconds=%d\nwave_timeout_seconds=%d\nbase_count=%d\nper_wave=%d\n"
                            "max_alive=%d\nradius_min=%d\nradius_max=%d\n",
                         Cfg.firstWave, Cfg.breakSeconds, Cfg.waveTimeout, Cfg.baseCount, Cfg.perWave, Cfg.maxAlive,
                         Cfg.radiusMin, Cfg.radiusMax);
            std::fclose(f);
        }
        return;
    }
    char line[4096];
    while (std::fgets(line, sizeof line, f)) {
        int v = 0, id = 0, used = 0;
        if (std::sscanf(line, "first_wave_seconds=%d", &v) == 1) Cfg.firstWave = v;
        if (std::sscanf(line, "break_seconds=%d", &v) == 1) Cfg.breakSeconds = v;
        if (std::sscanf(line, "wave_timeout_seconds=%d", &v) == 1) Cfg.waveTimeout = v;
        if (std::sscanf(line, "base_count=%d", &v) == 1) Cfg.baseCount = v;
        if (std::sscanf(line, "per_wave=%d", &v) == 1) Cfg.perWave = v;
        if (std::sscanf(line, "max_alive=%d", &v) == 1) Cfg.maxAlive = v;
        if (std::sscanf(line, "radius_min=%d", &v) == 1) Cfg.radiusMin = v;
        if (std::sscanf(line, "radius_max=%d", &v) == 1) Cfg.radiusMax = v;
        if (std::sscanf(line, "normal_monsters=%d", &v) == 1) Cfg.normalMonsters = v;
        if (std::sscanf(line, "level_%d=%n", &id, &used) == 1 && used > 0) {
            std::vector<int>& list = Cfg.levels[id];
            for (char* t = std::strtok(line + used, ", \r\n"); t; t = std::strtok(nullptr, ", \r\n")) list.push_back(std::atoi(t));
        }
    }
    std::fclose(f);
}

void* FirstPlayer(void* game) {
    for (std::uint32_t guid = 0; guid < 16; ++guid)
        if (void* p = GetServerUnit(game, 0, guid)) return p;
    return nullptr;
}

std::uint32_t UnitGuid(void* unit) { return *reinterpret_cast<std::uint32_t*>(static_cast<std::uint8_t*>(unit) + 0x08); }

// Removes dead or vanished monsters from the wave list.
void Prune(void* game, GameState& s) {
    s.alive.erase(std::remove_if(s.alive.begin(), s.alive.end(), [&](std::uint32_t guid) {
                      void* u = GetServerUnit(game, 1, guid);
                      return !u || IsDead(u);
                  }),
                  s.alive.end());
}

// GUIDs of the monsters in the rooms around a room. A spawn call brings a whole pack (like the
// normal population), so a wave's monsters are the ones that are new after spawning.
std::vector<std::uint32_t> MonstersAround(void* room) {
    std::vector<std::uint32_t> out;
    void** rooms = nullptr;
    std::uint32_t count = 0;
    RoomNeighbours(room, &rooms, &count);
    for (std::uint32_t r = 0; r < count && rooms; ++r)
        for (void* u = RoomFirstUnit(rooms[r]); u; u = NextUnit(u))
            if (UnitType(u) == 1 && !IsDead(u)) out.push_back(UnitGuid(u));
    return out;
}

void SpawnWave(void* game, GameState& s, void* player, int frame) {
    const auto it = Cfg.levels.find(s.levelId);
    if (it == Cfg.levels.end() || it->second.empty()) return;
    void* room = GetRoom(player);
    const std::uint64_t c = GetCoords(player);
    const int px = static_cast<int>(c & 0xFFFF), py = static_cast<int>((c >> 16) & 0xFFFF);
    s.wave += 1;
    s.waveStartFrame = frame;
    const int want = Cfg.baseCount + Cfg.perWave * (s.wave - 1);  // packs
    if (static_cast<int>(s.alive.size()) >= Cfg.maxAlive) {
        Log("wave %d waits: %zu monsters still alive", s.wave, s.alive.size());
        s.wave -= 1;  // not started: the same wave comes once there is room
        return;
    }
    const std::vector<std::uint32_t> before = MonstersAround(room);
    int made = 0;
    for (int tries = 0; made < want && tries < want * 12; ++tries) {
        const double angle = (Rand() % 3600) * 3.14159265 / 1800.0;
        const int r = Cfg.radiusMin + static_cast<int>(Rand() % std::max(1, Cfg.radiusMax - Cfg.radiusMin + 1));
        const int x = px + static_cast<int>(std::lround(std::cos(angle) * r));
        const int y = py + static_cast<int>(std::lround(std::sin(angle) * r));
        void* target = FindRoom(room, x, y);
        if (!target) continue;
        const std::uint32_t mask = CheckMask(target, x, y, 0xFFFF);
        if (mask == 0x27 || (mask & 1)) continue;
        if (LevelIdOf(target) != s.levelId) continue;  // stay in this level (no spawns behind walls into towns)
        const int cls = it->second[Rand() % it->second.size()];
        if (Spawn(game, target, x, y, cls, 1, -1, 0x80)) {
            ++made;
            // packs vary in size: stop at max_alive monsters (this wave's new ones plus the earlier ones)
            const int now = static_cast<int>(MonstersAround(room).size() - before.size());
            if (static_cast<int>(s.alive.size()) + now >= Cfg.maxAlive) break;
        }
    }
    for (std::uint32_t guid : MonstersAround(room))
        if (std::find(before.begin(), before.end(), guid) == before.end() &&
            std::find(s.alive.begin(), s.alive.end(), guid) == s.alive.end())
            s.alive.push_back(guid);
    Log("wave %d in level %d at (%d,%d): %d of %d packs, %zu monsters alive", s.wave, s.levelId, px, py, made, want, s.alive.size());
}

void __fastcall PopulateDetour(void* game, void* room) {
    if (!Cfg.normalMonsters && room) {
        const int level = LevelIdOf(room);
        if (!IsTown(level) && Cfg.levels.count(level)) return;  // only the waves bring monsters here
    }
    OrigPopulate(game, room);
}

void __fastcall UpdateDetour(void* game) {
    OrigUpdate(game);
    if (!game) return;
    void* player = FirstPlayer(game);
    if (!player) return;
    void* room = GetRoom(player);
    if (!room) return;
    GameState& s = Games[game];
    const int frame = *reinterpret_cast<int*>(static_cast<std::uint8_t*>(game) + 0x170);
    const int level = LevelIdOf(room);
    if (level != s.levelId) {
        s.levelId = level;
        const bool active = !IsTown(level) && Cfg.levels.count(level);
        s.nextWaveFrame = active ? frame + Cfg.firstWave * 25 : -1;
        Log("level %d: %s", level, active ? "survival" : "no waves");
    }
    if (s.nextWaveFrame < 0) return;
    if ((frame & 7) == 0) Prune(game, s);
    if (s.wave > 0 && s.nextWaveFrame == INT32_MAX) {
        // wave running: the next one comes after a break once it is cleared, or after the timeout
        if (s.alive.empty()) {
            s.nextWaveFrame = frame + Cfg.breakSeconds * 25;
            Log("wave %d cleared after %d s", s.wave, (frame - s.waveStartFrame) / 25);
        } else if (frame - s.waveStartFrame > Cfg.waveTimeout * 25) {
            s.nextWaveFrame = frame;
            Log("wave %d timed out with %zu alive", s.wave, s.alive.size());
        }
        return;
    }
    if (frame >= s.nextWaveFrame) {
        SpawnWave(game, s, player, frame);
        s.nextWaveFrame = INT32_MAX;
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
    Rng ^= GetTickCount();
    const auto base = reinterpret_cast<std::uintptr_t>(GetModuleHandleW(nullptr));
    GetServerUnit = reinterpret_cast<GetServerUnitFn>(base + 0x48FE80);
    GetRoom = reinterpret_cast<UnitFn>(base + 0x34B440);
    GetCoords = reinterpret_cast<CoordsFn>(base + 0x34A110);
    LevelIdOf = reinterpret_cast<LevelIdFn>(base + 0x2EFC10);
    IsTown = reinterpret_cast<IsTownFn>(base + 0x327850);
    FindRoom = reinterpret_cast<FindRoomFn>(base + 0x38DFB0);
    CheckMask = reinterpret_cast<CheckMaskFn>(base + 0x366250);
    Spawn = reinterpret_cast<SpawnFn>(base + 0x492CF0);
    IsDead = reinterpret_cast<IsDeadFn>(base + 0x34C2C0);
    RoomNeighbours = reinterpret_cast<NeighboursFn>(base + 0x2EFDE0);
    RoomFirstUnit = reinterpret_cast<UnitFn>(base + 0x2EFD90);
    NextUnit = reinterpret_cast<UnitFn>(base + 0x34B4A0);
    UnitType = reinterpret_cast<TypeFn>(base + 0x34B9D0);
    const bool ok = context->InstallInlineHook(D2RL::MakeInlineHook(
        UpdateRva, UpdateBytes.data(), static_cast<std::uint32_t>(UpdateBytes.size()),
        reinterpret_cast<void*>(&UpdateDetour), reinterpret_cast<void**>(&OrigUpdate)));
    const bool pop = context->InstallInlineHook(D2RL::MakeInlineHook(
        PopulateRva, PopulateBytes.data(), static_cast<std::uint32_t>(PopulateBytes.size()),
        reinterpret_cast<void*>(&PopulateDetour), reinterpret_cast<void**>(&OrigPopulate)));
    Log("loaded: %zu levels with monster lists, hooks %d %d, normal monsters %s", Cfg.levels.size(), ok, pop,
        Cfg.normalMonsters ? "on" : "off");
    if (!ok) D2RL::LogError(context, "Wave Survival: hook failed (unsupported game build?)");
    return ok;
}

D2RL_PLUGIN_EXPORT void D2RLoaderUnloadPlugin() noexcept {}
