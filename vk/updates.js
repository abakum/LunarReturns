"use strict";

const messageNew = require('./handlers/message_new.js');
const messageEvent = require('./handlers/message_event.js');
const messageReactionEvent = require('./handlers/message_reaction_event.js');

const handlers = new Map([
    ['message_new', messageNew],
    ['message_event', messageEvent],
    ['message_reaction_event', messageReactionEvent],
]);

function createUpdateRouter(deps, byPeer) {
    async function invoke(handler, payload, peerId, source, update = null, groupId = deps.groupId) {
        const run = () => handler(payload, { deps, peerId, source, update, groupId, ownerId: deps.ownerId });
        try {
            return await (source === 'long_poll' && deps.withWorkerUpdate ? deps.withWorkerUpdate(peerId, run) : run());
        } catch (e) {
            if (!deps.isWorkerCancelled?.(e)) throw e;
        }
    }

    return {
        longPoll(update, groupId, trace) {
            if (!update?.object || (groupId && Number(update.group_id) !== groupId)) return;
            const reaction = typeof update.type === 'string' && update.type.includes('reaction');
            const handler = handlers.get(reaction ? 'message_reaction_event' : update.type);
            if (!handler) return;
            const payload = handler === messageNew ? update.object.message || update.object : update.object;
            const peerId = payload?.peer_id;
            if (peerId == null) return;
            if (handler === messageEvent && (deps.hasDnaExport || deps.cancelWorkerIndicator)) {
                const p = deps.unpay(payload.payload);
                const close = p === 'close' || p?.c === 'close' || (p?.c === 'dateless' && p.a === 'close');
                if (p?.c === 'work:cancel' || (close && deps.hasDnaExport?.(peerId, payload.conversation_message_id))) {
                    return byPeer(peerId, () => invoke(handler, payload, peerId, 'long_poll', update, groupId),
                        trace && trace(update, payload), true);
                }
            }
            if (reaction) console.log('reaction upd:', JSON.stringify(payload).slice(0, 400));
            return byPeer(peerId, () => invoke(handler, payload, peerId, 'long_poll', update, groupId),
                trace && trace(update, payload));
        },
        catchUp(message, peerId) {
            // Replay runs before Long Poll and keeps its existing sequential error/timing boundary.
            return invoke(messageNew, message, peerId, 'catch_up');
        },
        async direct(type, payload) {
            const handler = handlers.get(type);
            if (handler && payload?.peer_id != null)
                return invoke(handler, payload, payload.peer_id, 'direct');
        },
    };
}

module.exports = { createUpdateRouter };
