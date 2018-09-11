import { API, CreateAccountParams, CreateStoreParams } from "@padlock/core/src/api";
import { Storage, Storable } from "@padlock/core/src/storage";
import { Store } from "@padlock/core/src/store";
import { DateString, Base64String } from "@padlock/core/src/encoding";
import { Auth, Account, AccountID, Session } from "@padlock/core/src/auth";
import { Err, ErrorCode } from "@padlock/core/src/error";
import { Invite } from "@padlock/core/src/invite";
import { uuid } from "@padlock/core/src/util";
import { Server as SRPServer } from "@padlock/core/src/srp";
import { NodeCryptoProvider } from "@padlock/core/src/node-crypto-provider";
import { Sender } from "./sender";
import { EmailVerificationMessage, InviteMessage } from "./messages";
import { RequestState } from "./server";
import { randomBytes } from "crypto";

const crypto = new NodeCryptoProvider();

export class EmailVerification implements Storable {
    id = uuid();
    kind = "email-verification";
    code: string = "";
    created: DateString = new Date().toISOString();

    get pk() {
        return this.email;
    }

    constructor(public email: string) {
        this.code = randomBytes(3).toString("hex");
    }

    async serialize() {
        return {
            id: this.id,
            email: this.email,
            code: this.code
        };
    }

    async deserialize(raw: any) {
        this.id = raw.id;
        this.email = raw.email;
        this.code = raw.code;
        return this;
    }
}

const pendingAuths = new Map<string, SRPServer>();

export class ServerAPI implements API {
    constructor(private storage: Storage, private sender: Sender, private state: RequestState) {}

    async verifyEmail({ email }: { email: string }) {
        const v = new EmailVerification(email);
        await this.storage.set(v);
        this.sender.send(email, new EmailVerificationMessage(v));
        return { id: v.id };
    }

    async initAuth({ email }: { email: string }): Promise<{ auth: Auth; B: Base64String }> {
        const auth = new Auth(email);

        try {
            await this.storage.get(auth);
        } catch (e) {
            if (e.code === ErrorCode.NOT_FOUND) {
                // Account does not exist. Send randomized values
                const auth = new Auth(email);
                auth.keyParams.salt = await crypto.randomBytes(32);
                auth.account = uuid();
                return {
                    auth,
                    B: await crypto.randomBytes(32)
                };
            }
            throw e;
        }

        const srp = new SRPServer();
        await srp.initialize(auth.verifier);

        pendingAuths.set(auth.account, srp);

        return {
            auth,
            B: srp.B!
        };
    }

    async createSession({ account, A, M }: { account: AccountID; A: Base64String; M: Base64String }): Promise<Session> {
        const srp = pendingAuths.get(account);

        if (!srp) {
            throw new Err(ErrorCode.INVALID_CREDENTIALS);
        }

        await srp.setA(A);

        if (M !== srp.M1) {
            throw new Err(ErrorCode.INVALID_CREDENTIALS);
        }

        const acc = new Account(account);

        await this.storage.get(acc);

        const session = new Session(uuid());
        session.account = account;
        session.device = this.state.device;
        session.key = srp.K!;

        acc.sessions.add(session.id);

        await Promise.all([this.storage.set(session), this.storage.set(acc)]);

        pendingAuths.delete(account);

        // Delete key before returning session
        session.key = "";
        return session;
    }

    async revokeSession(session: Session) {
        const { account } = this._requireAuth();

        await this.storage.get(session);

        account.sessions.delete(session.id);

        await Promise.all([this.storage.delete(session), this.storage.set(account)]);
    }

    async getSessions() {
        const { account } = this._requireAuth();
        console.log("get sessions", account.sessions);
        const sessions = Promise.all(
            Array.from(account.sessions).map(async id => {
                const session = new Session(id);
                try {
                    await this.storage.get(session);
                } catch (e) {
                    if (e.code === ErrorCode.NOT_FOUND) {
                        account.sessions.delete(id);
                    } else {
                        throw e;
                    }
                }
                return session;
            })
        );
        await this.storage.set(account);
        return sessions;
    }

    async createAccount(params: CreateAccountParams): Promise<Account> {
        const {
            account,
            auth,
            emailVerification: { id, code }
        } = params;

        const ev = new EmailVerification(auth.email);
        try {
            await this.storage.get(ev);
        } catch (e) {
            if (e.code === ErrorCode.NOT_FOUND) {
                throw new Err(ErrorCode.EMAIL_VERIFICATION_FAILED, "Email verification required.");
            } else {
                throw e;
            }
        }
        if (ev.id !== id || ev.code !== code.toLowerCase()) {
            throw new Err(ErrorCode.EMAIL_VERIFICATION_FAILED, "Invalid verification code. Please try again!");
        }

        // Make sure account does not exist yet
        try {
            await this.storage.get(auth);
            throw new Err(ErrorCode.ACCOUNT_EXISTS, "This account already exists!");
        } catch (e) {
            if (e.code !== ErrorCode.NOT_FOUND) {
                throw e;
            }
        }

        account.id = uuid();
        auth.account = account.id;

        const store = new Store(uuid(), "Main");
        store.owner = account.id;
        account.store = store.id;

        await Promise.all([this.storage.set(account), this.storage.set(store), this.storage.set(auth)]);

        return account;
    }

    async getAccount() {
        const { account } = this._requireAuth();
        return account;
    }

    async updateAccount(account: Account) {
        const existing = this._requireAuth().account;
        existing.update(account);
        await this.storage.set(existing);
        return existing;
    }

    async getStore(store: Store) {
        const { account } = this._requireAuth();

        await this.storage.get(store);
        const { read } = store.getPermissions(account);

        if (!read) {
            throw new Err(ErrorCode.NOT_FOUND);
        }

        return store;
    }

    async updateStore(store: Store) {
        const { account } = this._requireAuth();

        const existing = new Store(store.id);
        await this.storage.get(existing);

        existing.access(account);
        existing.update(store);

        await this.storage.set(store);

        return store;
    }

    async createStore(params: CreateStoreParams) {
        const { account } = this._requireAuth();

        const { name } = params;
        const store = await new Store(uuid(), name);
        store.owner = account.id;

        await Promise.all([this.storage.set(account), this.storage.set(store)]);

        return store;
    }

    async updateInvite(invite: Invite) {
        const { account } = this._requireAuth();

        const group = new Store(invite.group!.id);
        await this.storage.get(group);

        const existing = group.getInvite(invite.email);

        if (!group.isAdmin(account) && existing && existing.email !== account.email) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        group.updateInvite(invite);

        await this.storage.set(group);

        if (!invite.accepted) {
            this.sender.send(
                invite.email,
                new InviteMessage({
                    name: invite.group!.name,
                    kind: "store",
                    sender: invite.invitor ? invite.invitor.name || invite.invitor.email : "someone",
                    url: `https://127.0.0.1:3000/store/${invite.group!.id}`
                })
            );
        }

        return invite;
    }

    async deleteInvite(invite: Invite) {
        const { account } = this._requireAuth();

        const group = new Store(invite.group!.id);
        await this.storage.get(group);

        if (!group.isAdmin(account)) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        group.deleteInvite(invite);

        await this.storage.set(group);
    }

    private _requireAuth(): { account: Account; session: Session } {
        const { account, session } = this.state;

        if (!session || !account) {
            throw new Err(ErrorCode.INVALID_SESSION);
        }

        return { account, session };
    }
}
