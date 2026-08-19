/**
 * Injection token for the Ziggurat CacheManager.
 *
 * The string is deliberately namespaced: `@nestjs/cache-manager` publishes a
 * token whose value is the bare string "CACHE_MANAGER", and ZigguratModule
 * registers globally, so sharing that value would make injection order decide
 * which manager a consumer receives.
 */
export const CACHE_MANAGER = "ZIGGURAT_CACHE_MANAGER";
