// d2r-fixed-seed: D2RLoader plugin that makes every game use the same map seed, so random
// levels are generated identically each time (needed for level edits to stay in place).
//
// Hook target (D2RLoader 1.3.1-beta embedded game, see d2r-re catalog):
//   RVA 0x2ef1c0  DUNGEON_AllocAct(uint8 version, uint8 act, uint32 seed, int isClient, ...)
// The server calls it with game+0x12C (the game's map seed), the client with the seed it
// received. Replacing the seed in both calls keeps server and client in sync.
//
// Config: d2r-fixed-seed.ini next to the DLL:
//   enabled=1
//   seed=1234567890        (decimal or 0x hex)

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>

#include <D2RLPlugin/api.h>

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

namespace {

constexpr std::uint32_t AllocActRva = 0x2EF1C0;
// First bytes of DUNGEON_AllocAct in the supported build (register saves of the prologue).
constexpr std::array<std::uint8_t, 15> AllocActBytes{
    0x48, 0x89, 0x5C, 0x24, 0x08, 0x48, 0x89, 0x6C, 0x24, 0x10, 0x48, 0x89, 0x74, 0x24, 0x18};

const D2RL::PluginInfo Info{
    .infoSize = D2RL::PluginInfoSize,
    .apiVersion = D2RL_PLUGIN_API_VERSION,
    .id = "d2r-fixed-seed",
    .name = "Fixed Map Seed",
    .version = "0.1.0",
    .author = "local",
    .description = "Uses one fixed map seed for every game so levels never regenerate.",
    .flags = D2RL::PluginFlags::Shared | D2RL::PluginFlags::NativeHooks,
    .reserved = {},
};

using AllocActFn = void*(__fastcall*)(std::uintptr_t version, std::uintptr_t act, std::uint32_t seed,
                                      std::uintptr_t isClient, std::uintptr_t a5, std::uintptr_t a6,
                                      std::uintptr_t a7, std::uintptr_t a8, std::uintptr_t a9);
AllocActFn Original = nullptr;
std::uint32_t FixedSeed = 1234567890u;
const D2RL::PluginContext* Context = nullptr;

void* __fastcall AllocActDetour(std::uintptr_t version, std::uintptr_t act, std::uint32_t seed,
                                std::uintptr_t isClient, std::uintptr_t a5, std::uintptr_t a6,
                                std::uintptr_t a7, std::uintptr_t a8, std::uintptr_t a9) {
    (void)seed;
    return Original(version, act, FixedSeed, isClient, a5, a6, a7, a8, a9);
}

std::string ConfigPath() {
    char path[MAX_PATH]{};
    HMODULE self{};
    GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       reinterpret_cast<LPCSTR>(&AllocActDetour), &self);
    GetModuleFileNameA(self, path, MAX_PATH);
    std::string p = path;
    return p.substr(0, p.find_last_of("\\/")) + "\\d2r-fixed-seed.ini";
}

bool ReadConfig() {
    const std::string path = ConfigPath();
    FILE* f = std::fopen(path.c_str(), "r");
    if (!f) {
        if ((f = std::fopen(path.c_str(), "w"))) {
            std::fprintf(f, "; Fixed map seed for every game (decimal or 0x hex)\nenabled=1\nseed=%u\n", FixedSeed);
            std::fclose(f);
        }
        return true;
    }
    bool enabled = true;
    char line[256];
    while (std::fgets(line, sizeof line, f)) {
        if (!std::strncmp(line, "enabled=", 8)) enabled = std::atoi(line + 8) != 0;
        if (!std::strncmp(line, "seed=", 5)) FixedSeed = static_cast<std::uint32_t>(std::strtoul(line + 5, nullptr, 0));
    }
    std::fclose(f);
    return enabled;
}

}  // namespace

D2RL_PLUGIN_EXPORT auto D2RLoaderGetPluginInfo() noexcept -> const D2RL::PluginInfo* { return &Info; }

D2RL_PLUGIN_EXPORT auto D2RLoaderLoadPlugin(const D2RL::PluginContext* context) noexcept -> bool {
    if (!D2RL::HasContext(context) || context->apiVersion < D2RL_PLUGIN_API_VERSION) return false;
    Context = context;
    if (!ReadConfig()) {
        D2RL::LogInfo(context, "Fixed Map Seed: disabled in d2r-fixed-seed.ini");
        return true;
    }
    const bool ok = context->InstallInlineHook(
        D2RL::MakeInlineHook(AllocActRva, AllocActBytes.data(), static_cast<std::uint32_t>(AllocActBytes.size()),
                             reinterpret_cast<void*>(&AllocActDetour), reinterpret_cast<void**>(&Original)));
    if (!ok || !Original) {
        D2RL::LogError(context, "Fixed Map Seed: DUNGEON_AllocAct not found (unsupported game build); no hook installed.");
        return false;
    }
    D2RL::LogInfoF(context, "Fixed Map Seed: every game uses map seed %u", FixedSeed);
    return true;
}

D2RL_PLUGIN_EXPORT void D2RLoaderUnloadPlugin() noexcept { Context = nullptr; }
