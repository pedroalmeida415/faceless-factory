import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "~/features/auth/config";

export const { GET, POST } = toNextJsHandler(auth.handler);
