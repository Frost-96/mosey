if (new URLSearchParams(location.search).has("settings"))
  void import("./settings/settings");
else void import("./pet/renderer");
