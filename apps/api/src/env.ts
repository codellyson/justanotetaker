import type { Auth, AuthEnv } from "./auth";

export type Bindings = AuthEnv;

export type Variables = {
  auth: Auth;
  user: Auth extends { $Infer: { Session: { user: infer U } } } ? U | null : unknown;
  session: Auth extends { $Infer: { Session: { session: infer S } } } ? S | null : unknown;
  userId: string;
};

export type Env = { Bindings: Bindings; Variables: Variables };
