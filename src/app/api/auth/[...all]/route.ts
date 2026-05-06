import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "~/features/auth/server/config";

export const { GET, POST } = toNextJsHandler(auth.handler);
