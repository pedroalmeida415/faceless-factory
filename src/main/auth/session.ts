import { headers } from "next/headers";
import { cache } from "react";
import { auth } from "~/main/auth/better-auth";

export const getSession = cache(async () => auth.api.getSession({ headers: await headers() }));
