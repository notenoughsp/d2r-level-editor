// d2r-collision-probe: test helper. Hooks the per-game server tick and, once a player is in
// the game, writes the real server-side collision around the player plus the game's map seed
// to collision-probe.txt next to the DLL. Read-only: it never changes game state.
//
// RVAs from the d2r-re catalog (D2RLoader 1.3.1-beta embedded game):
//   0x406550 GAME_ProcessGame(game)            hooked
//   0x48fe80 SUNIT_GetServerUnit(game, type, guid)
//   0x34a110 UNITS_GetCoords(unit) -> x | y << 16
//   0x34b440 UNITS_GetRoom(unit)
//   0x366250 COLLISION_CheckMask(room, x, y, mask) -> flags & mask (0x27 outside rooms)
//   game+0x12C map seed (passed to DUNGEON_AllocAct)

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>

#include <D2RLPlugin/api.h>

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>

namespace {

constexpr std::uint32_t ProcessGameRva = 0x406550;
constexpr std::array<std::uint8_t, 9> ProcessGameBytes{0x48, 0x89, 0x74, 0x24, 0x20, 0x55, 0x57, 0x41, 0x57};

const D2RL::PluginInfo Info{
    .infoSize = D2RL::PluginInfoSize,
    .apiVersion = D2RL_PLUGIN_API_VERSION,
    .id = "d2r-collision-probe",
    .name = "Collision Probe",
    .version = "0.1.0",
    .author = "local",
    .description = "Test helper: logs server collision around the player and the map seed.",
    .flags = D2RL::PluginFlags::Shared | D2RL::PluginFlags::NativeHooks,
    .reserved = {},
};

using ProcessGameFn = void(__fastcall*)(void* game);
using GetServerUnitFn = void*(__fastcall*)(void* game, int type, std::uint32_t guid);
using GetCoordsFn = std::uint64_t(__fastcall*)(void* unit);
using GetRoomFn = void*(__fastcall*)(void* unit);
using CheckMaskFn = std::uint32_t(__fastcall*)(void* room, int x, int y, std::uint16_t mask);

ProcessGameFn Original = nullptr;
GetServerUnitFn GetServerUnit = nullptr;
GetCoordsFn GetCoords = nullptr;
GetRoomFn GetRoom = nullptr;
CheckMaskFn CheckMask = nullptr;

std::string OutPath;
void* LastGame = nullptr;
int LastX = -1000, LastY = -1000, Dumps = 0;
unsigned Ticks = 0;

void Dump(void* game, void* player) {
    const std::uint64_t c = GetCoords(player);
    const int px = static_cast<int>(c & 0xFFFF), py = static_cast<int>((c >> 16) & 0xFFFF);
    if (std::abs(px - LastX) < 3 && std::abs(py - LastY) < 3 && game == LastGame) return;
    void* room = GetRoom(player);
    if (!room) return;
    FILE* f = std::fopen(OutPath.c_str(), "a");
    if (!f) return;
    const std::uint32_t seed = *reinterpret_cast<std::uint32_t*>(static_cast<std::uint8_t*>(game) + 0x12C);
    const std::uint32_t here = CheckMask(room, px, py, 0xFFFF);
    std::fprintf(f, "=== game %p seed %u player at subtile (%d, %d) flags under player 0x%X\n", game, seed, px, py, here);
    const int R = Dumps == 0 ? 30 : 8;  // full map once, then a small window per move
    for (int y = py - R; y <= py + R; ++y) {
        char line[64]{};
        int i = 0;
        for (int x = px - R; x <= px + R; ++x) {
            const std::uint32_t m = CheckMask(room, x, y, 0xFFFF);
            line[i++] = (x == px && y == py) ? 'P' : (m == 0x27 ? ' ' : (m & 1) ? '#' : '.');
        }
        std::fprintf(f, "%s\n", line);
    }
    std::fclose(f);
    LastGame = game;
    LastX = px;
    LastY = py;
    ++Dumps;
}

void __fastcall ProcessGameDetour(void* game) {
    Original(game);
    if (!game || Dumps >= 60 || (++Ticks % 25) != 0) return;
    for (std::uint32_t guid = 0; guid < 16; ++guid) {
        if (void* player = GetServerUnit(game, 0, guid)) {
            Dump(game, player);
            break;
        }
    }
}

}  // namespace

D2RL_PLUGIN_EXPORT auto D2RLoaderGetPluginInfo() noexcept -> const D2RL::PluginInfo* { return &Info; }

D2RL_PLUGIN_EXPORT auto D2RLoaderLoadPlugin(const D2RL::PluginContext* context) noexcept -> bool {
    if (!D2RL::HasContext(context) || context->apiVersion < D2RL_PLUGIN_API_VERSION) return false;
    const auto base = reinterpret_cast<std::uintptr_t>(GetModuleHandleW(nullptr));
    GetServerUnit = reinterpret_cast<GetServerUnitFn>(base + 0x48FE80);
    GetCoords = reinterpret_cast<GetCoordsFn>(base + 0x34A110);
    GetRoom = reinterpret_cast<GetRoomFn>(base + 0x34B440);
    CheckMask = reinterpret_cast<CheckMaskFn>(base + 0x366250);

    char path[MAX_PATH]{};
    HMODULE self{};
    GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       reinterpret_cast<LPCSTR>(&ProcessGameDetour), &self);
    GetModuleFileNameA(self, path, MAX_PATH);
    OutPath = std::string(path).substr(0, std::string(path).find_last_of("\\/")) + "\\collision-probe.txt";
    if (FILE* f = std::fopen(OutPath.c_str(), "w")) {
        std::fprintf(f, "collision probe loaded\n");
        std::fclose(f);
    }
    const bool ok = context->InstallInlineHook(
        D2RL::MakeInlineHook(ProcessGameRva, ProcessGameBytes.data(), static_cast<std::uint32_t>(ProcessGameBytes.size()),
                             reinterpret_cast<void*>(&ProcessGameDetour), reinterpret_cast<void**>(&Original)));
    if (!ok || !Original) {
        D2RL::LogError(context, "Collision Probe: GAME_ProcessGame hook failed");
        return false;
    }
    return true;
}

D2RL_PLUGIN_EXPORT void D2RLoaderUnloadPlugin() noexcept {}
