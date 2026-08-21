#pragma once

// Non-blocking serial command reader. Call every loop; never waits on input.
// Module-01 asks for the open questions to be adjustable without recompiling,
// and this is the cheap way to do it.
void console_tick();

// Prints the command list.
void console_help();
