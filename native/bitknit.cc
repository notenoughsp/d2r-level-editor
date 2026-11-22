// Thin C ABI around pybg3's BitKnit2 decoder (third_party/pybg3/src/rans.h, MIT).
#define __builtin_unreachable() __assume(0)  // MSVC equivalent of the GCC builtin used in rans.h
#include "../third_party/pybg3/src/rans.h"

extern "C" __declspec(dllexport) int bitknit2_decompress(const void* src, unsigned src_len,
                                                         void* dst, unsigned dst_len) {
  try {
    rans::bitknit2_state state(static_cast<uint8_t*>(dst), dst_len);
    return state.decode(const_cast<uint16_t*>(static_cast<const uint16_t*>(src)), src_len) ? 1 : 0;
  } catch (...) {
    return 0;
  }
}
