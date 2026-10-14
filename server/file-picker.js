const { execFile } = require("child_process");

function chooseVideoFile(callback) {
  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms", "$d = New-Object System.Windows.Forms.OpenFileDialog",
      "$d.Title = 'Choose a video for WatchParty'",
      "$d.Filter = 'Video files|*.mp4;*.webm;*.mkv;*.mov;*.m4v;*.ogv;*.ogg;*.avi;*.ts;*.mts;*.m2ts;*.mpg;*.mpeg;*.flv;*.wmv|All files|*.*'",
      "$d.Multiselect = $false",
      "if ($d.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $d.FileName }"
    ].join("; ");
    execFile("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { windowsHide: false }, callback);
    return;
  }
  if (process.platform === "darwin") {
    execFile("osascript", ["-e", "POSIX path of (choose file with prompt \"Choose a video for WatchParty\")"], callback);
    return;
  }
  execFile("sh", ["-c", "command -v zenity >/dev/null && exec zenity --file-selection --title='Choose a video for WatchParty' --file-filter='Video files | *.mp4 *.webm *.mkv *.mov *.m4v *.ogv *.ogg *.avi *.ts *.mts *.m2ts *.mpg *.mpeg *.flv *.wmv'; command -v kdialog >/dev/null && exec kdialog --getopenfilename . '*.mp4 *.webm *.mkv *.mov *.m4v *.ogv *.ogg *.avi *.ts *.mts *.m2ts *.mpg *.mpeg *.flv *.wmv|Video files'; exit 127"], callback);
}

module.exports = { chooseVideoFile };
