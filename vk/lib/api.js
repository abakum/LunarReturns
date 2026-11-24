"use strict";

const VK_API = "https://api.vk.com/method/";
const VK_VERSION = "5.199";

function createVkApi(token, logRaw) {
    return async function vkApi(method, params) {
        // undefined-параметры не передаём вовсе: URLSearchParams превратил бы их
        // в строки «undefined» (ВК показывает их как текст сообщения); вложенные
        // объекты (клавиатуры) — строкуем
        const clean = {};
        for (const [k, v] of Object.entries(params)) {
            if (v === undefined) continue;
            clean[k] = v && typeof v === "object" && !Buffer.isBuffer(v) ? JSON.stringify(v) : v;
        }
        const qs = new URLSearchParams(Object.assign({ access_token: token, v: VK_VERSION }, clean));
        if (logRaw) console.log(">> " + method, qs.toString().replace(/access_token=[^&]+/, "access_token=…"));
        // POST с form-body — как в vksdk/pinguin: клавиатуры в query string
        // (GET) ВК портит («unknown fields» на каждой кнопке)
        const res = await fetch(VK_API + method, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: qs,
            signal: AbortSignal.timeout(30000)
        });
        if (!res.ok) throw new Error(method + " HTTP " + res.status);
        const body = await res.json();
        if (logRaw) console.log("<< " + method, JSON.stringify(body).slice(0, 800));
        if (body.error) throw new Error(method + " " + body.error.error_code + ": " + body.error.error_msg);
        return body.response;
    };
}
module.exports = { createVkApi };
