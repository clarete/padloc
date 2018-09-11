import { Store } from "@padlock/core/src/store";
import { Account, Auth, Session } from "@padlock/core/src/auth";
import { CreateStoreParams } from "@padlock/core/src/api";
import { Err, ErrorCode } from "@padlock/core/src/error";
import { Invite } from "@padlock/core/src/invite";
import { Context } from "./server";

export async function verifyEmail(ctx: Context) {
    const { email } = ctx.request.body;

    if (typeof email !== "string") {
        throw new Err(ErrorCode.BAD_REQUEST, "No email provided!");
    }

    ctx.body = await ctx.api.verifyEmail({ email });
}

export async function initAuth(ctx: Context) {
    const { email } = ctx.request.body;
    if (typeof email !== "string") {
        throw new Err(ErrorCode.BAD_REQUEST);
    }
    const { auth, B } = await ctx.api.initAuth({ email });
    ctx.body = {
        auth: await auth.serialize(),
        B
    };
}

export async function createSession(ctx: Context) {
    // TODO: check params
    const session = await ctx.api.createSession(ctx.request.body);
    ctx.body = await session.serialize();
}

export async function revokeSession(ctx: Context, id: string) {
    await ctx.api.revokeSession(new Session(id));
    ctx.body = "";
}

export async function getSessions(ctx: Context) {
    ctx.body = await ctx.api.getSessions();
}

export async function getAccount(ctx: Context) {
    const account = await ctx.api.getAccount(ctx.state.account!);
    ctx.body = await account.serialize();
}

export async function createAccount(ctx: Context) {
    // TODO: Check params
    const { account, auth, emailVerification } = ctx.request.body;
    const acc = await ctx.api.createAccount({
        account: await new Account().deserialize(account),
        auth: await new Auth().deserialize(auth),
        emailVerification
    });
    ctx.body = await acc.serialize();
}

export async function updateAccount(ctx: Context) {
    const account = await new Account().deserialize(ctx.request.body);
    const res = await ctx.api.updateAccount(account);
    ctx.body = await res.serialize();
}

export async function getStore(ctx: Context, id: string) {
    const store = await ctx.api.getStore(new Store(id));
    ctx.body = await store.serialize();
}

export async function updateStore(ctx: Context, id: string) {
    const store = await new Store(id).deserialize(ctx.request.body);
    const res = await ctx.api.updateStore(store);
    ctx.body = await res.serialize();
}

export async function createStore(ctx: Context) {
    const store = await ctx.api.createStore(ctx.request.body as CreateStoreParams);
    ctx.body = await store.serialize();
}

export async function updateInvite(ctx: Context) {
    const invite = await new Invite().deserialize(ctx.request.body);
    const res = await ctx.api.updateInvite(invite);
    ctx.body = await res.serialize();
}

export async function deleteInvite(ctx: Context) {
    const invite = await new Invite().deserialize(ctx.request.body);
    await ctx.api.deleteInvite(invite);
    ctx.status = 204;
}
