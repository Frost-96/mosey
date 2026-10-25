if (new URLSearchParams(location.search).has("settings"))
  void import("./settings");
else void import("./renderer");
