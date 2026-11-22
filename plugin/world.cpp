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

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>

#include <D2RLPlugin/api.h>

#include <array>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cctype>
#include <cstring>
#include <map>
#include <set>
#include <string>

namespace {

const D2RL::PluginInfo Info{
    .infoSize = D2RL::PluginInfoSize,
    .apiVersion = D2RL_PLUGIN_API_VERSION,
    .id = "d2r-world",
    .name = "New World Areas",
    .version = "0.1.0",
    .author = "local",
    .description = "Extra towns and returning to new areas for mods that add levels.",
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

struct Config {
    std::set<int> towns, world;
    int hub = -1, hubWarpType = 0, returnDelay = 40;
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
    return a;
}

D2RL_PLUGIN_EXPORT void D2RLoaderUnloadPlugin() noexcept {}
