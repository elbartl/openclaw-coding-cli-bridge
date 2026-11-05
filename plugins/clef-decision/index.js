// clef-decision: registers the `clef` decision provider (decisionModel role).
// Selectors: clef/clef, clef/clef-flash.
import { buildClefProvider } from './provider.js';

export default {
    id: 'clef-decision',
    name: 'Cloudflare CLEF decisions',
    description: 'Decision provider backed by Cloudflare Workers AI CLEF.',
    register(api) {
        try {
            const getPluginConfig = () => (api && api.pluginConfig) || {};
            api.registerDecisionProvider(buildClefProvider({ getPluginConfig }));
        } catch (e) {
            try { api.logger && api.logger.warn && api.logger.warn(`clef-decision: rejestracja nieudana: ${e && e.message}`); } catch (_) {}
        }
    },
};
