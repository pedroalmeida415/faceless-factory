import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "~/main/auth/better-auth";

export const { GET, POST } = toNextJsHandler(auth.handler);
