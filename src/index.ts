import { listen } from "@colyseus/tools";

import app from "./app.config.js";
import { installRoomReporter } from "./legion-room-reporter.js";
import { installPlatformBoards } from "./platformBoards.js";

// Listens on PORT (or 2567). Colyseus traps SIGTERM (a Legion deploy or scale-down) and closes the
// rooms; clients resolve a new endpoint through the matchmaker and rejoin (client net.js).
listen(app);

// Both are no-ops without the Bloxity hosting env vars: this pod's rooms for the matchmaker's
// cross-pod directory (Open Rooms, join by id), and the scores for Bloxity's own boards.
installRoomReporter();
installPlatformBoards();
