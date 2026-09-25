#ifndef StageSource
  #error StageSource is required
#endif
#ifndef OutputRoot
  #define OutputRoot StageSource
#endif

[Setup]
AppId={{D4702E08-310F-477A-91DA-DC45603DD6AF}
AppName=OFEnhancer
AppVersion=0.20.72
DefaultDirName={localappdata}\Programs\OFEnhancer
DefaultGroupName=OFEnhancer
OutputDir={#OutputRoot}
OutputBaseFilename=OFEnhancer-Setup-0.20.72
PrivilegesRequired=lowest
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile={#StageSource}\assets\ofenhancer.ico
UninstallDisplayIcon={app}\desktop\OFEnhancer.Desktop.exe
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no

[Files]
; The maintenance binary is embedded so Windows cleanup never executes from
; the old package it may remove. It does not open or coordinate Chrome.
Source: "{#StageSource}\desktop\*"; DestDir: "{tmp}\ofenhancer-maintenance\desktop"; Flags: dontcopy noencryption recursesubdirs createallsubdirs
Source: "{#StageSource}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\OFEnhancer"; Filename: "{app}\desktop\OFEnhancer.Desktop.exe"
Name: "{group}\Connect Chrome"; Filename: "{app}\desktop\OFEnhancer.Desktop.exe"; Parameters: "--chrome-setup"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "OFEnhancer"; ValueData: """{app}\desktop\OFEnhancer.Desktop.exe"""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\ofenhancer"; ValueType: string; ValueData: "URL:OFEnhancer Chrome setup"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\ofenhancer"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\ofenhancer\shell\open\command"; ValueType: string; ValueData: """{app}\desktop\OFEnhancer.Desktop.exe"" --chrome-setup"

[Run]
Filename: "{app}\desktop\OFEnhancer.Desktop.exe"; Description: "Start OFEnhancer"; Flags: postinstall nowait skipifsilent; Check: ShouldStartDesktop
Filename: "{app}\desktop\OFEnhancer.Desktop.exe"; Parameters: "--chrome-setup"; Description: "Open Chrome setup or reload guidance"; Flags: postinstall nowait skipifsilent unchecked; Check: ShouldOfferChromeSetup
Filename: "{app}\desktop\OFEnhancer.Desktop.exe"; Parameters: "--chrome-setup"; Flags: nowait skipifsilent; Check: ShouldLaunchFreshChromeSetup

[UninstallRun]
Filename: "{app}\desktop\OFEnhancer.Desktop.exe"; Parameters: "--uninstall-clean-data"; Flags: runhidden waituntilterminated; Check: ShouldDeleteUserData; RunOnceId: "CleanOwnedUserData"
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\tools\unregister-native-host.ps1"" -InstallRoot ""{app}"""; Flags: runhidden waituntilterminated; RunOnceId: "UnregisterNativeHost"

[Code]
var
  ExistingPage: TInputOptionWizardPage;
  KeepDataPage: TInputOptionWizardPage;
  FreshPage: TWizardPage;
  FreshSummary: TNewStaticText;
  FreshScope: TNewStaticText;
  ExistingUninstaller: String;
  ExistingInstallRoot: String;
  ExistingUninstallerPath: String;
  MaintenanceError: String;
  MaintenanceStatus: Integer;
  ExistingUninstallCompleted: Boolean;
  RemoveUserData: Boolean;
  ResumeFresh: Boolean;
  MaintenanceExtracted: Boolean;
  OriginalNextLeft: Integer;
  OriginalNextWidth: Integer;
  OriginalBackLeft: Integer;

function ExistingInstall(): Boolean;
begin
  Result := RegQueryStringValue(HKCU,
    'Software\Microsoft\Windows\CurrentVersion\Uninstall\{D4702E08-310F-477A-91DA-DC45603DD6AF}_is1',
    'UninstallString', ExistingUninstaller) and
    RegQueryStringValue(HKCU,
    'Software\Microsoft\Windows\CurrentVersion\Uninstall\{D4702E08-310F-477A-91DA-DC45603DD6AF}_is1',
    'InstallLocation', ExistingInstallRoot);
end;

function IsFreshReset(): Boolean;
begin
  Result := ResumeFresh or ((ExistingPage <> nil) and (ExistingPage.SelectedValueIndex = 1));
end;

function ShouldStartDesktop(): Boolean;
begin
  Result := not IsFreshReset();
end;

function ShouldOfferChromeSetup(): Boolean;
begin
  Result := not IsFreshReset();
end;

function ShouldLaunchFreshChromeSetup(): Boolean;
begin
  Result := IsFreshReset();
end;

function ExtractFreshMaintenance(): Boolean;
begin
  Result := True;
  if MaintenanceExtracted then Exit;
  try
    ExtractTemporaryFiles('{tmp}\ofenhancer-maintenance\desktop\*');
    MaintenanceExtracted := True;
  except
    Result := False;
  end;
end;

function RunFreshHelper(const Operation: String; var ExitCode: Integer): Boolean;
var
  Helper, Parameters, ErrorFile: String;
  ErrorText: AnsiString;
begin
  MaintenanceError := '';
  ErrorFile := ExpandConstant('{tmp}\ofenhancer-maintenance-error.txt');
  DeleteFile(ErrorFile);
  Helper := ExpandConstant('{tmp}\ofenhancer-maintenance\desktop\OFEnhancer.Desktop.exe');
  Parameters := Operation + ' --install-root "' + WizardDirValue + '" --package-version 0.20.72 --error-file "' + ErrorFile + '" --resume-root-file "' + ExpandConstant('{tmp}\ofenhancer-resume-root.txt') + '"';
  Result := Exec(Helper, Parameters, '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
  if LoadStringFromFile(ErrorFile, ErrorText) then MaintenanceError := UTF8Decode(ErrorText);
  if not Result then MaintenanceError := SysErrorMessage(ExitCode);
  Log(Operation + ': exit ' + IntToStr(ExitCode) + ' ' + MaintenanceError);
end;

function HasResumableFreshTransaction(): Boolean;
var
  ExitCode: Integer;
begin
  MaintenanceStatus := 3;
  if ExtractFreshMaintenance() and RunFreshHelper('--fresh-reinstall-status', ExitCode) then
    MaintenanceStatus := ExitCode;
  Result := MaintenanceStatus = 0;
end;

procedure InitializeWizard();
var
  FreshAfterID: Integer;
  SavedRoot: AnsiString;
begin
  OriginalNextLeft := WizardForm.NextButton.Left;
  OriginalNextWidth := WizardForm.NextButton.Width;
  OriginalBackLeft := WizardForm.BackButton.Left;
  ResumeFresh := HasResumableFreshTransaction();
  if ResumeFresh then
    if LoadStringFromFile(ExpandConstant('{tmp}\ofenhancer-resume-root.txt'), SavedRoot) then
    begin
      WizardForm.DirEdit.Text := UTF8Decode(SavedRoot);
      Log('Resuming approved installation root: ' + WizardDirValue);
    end;

  if ExistingInstall() or ResumeFresh then
  begin
    ExistingPage := CreateInputOptionPage(wpWelcome,
      'Choose this installation', 'Windows setup and Chrome setup are separate.',
      'A normal update preserves desktop data and the existing Chrome extension. Fresh reinstall cleans only the approved Windows scope, then OFEnhancer guides the still-required Chrome replacement after installation.', True, False);
    ExistingPage.Add('Update or reinstall — keep desktop data and Chrome state');
    ExistingPage.Add('Fresh reinstall — clean OFEnhancer Windows data, then reset Chrome in the app');
    ExistingPage.Add('Uninstall');
    ExistingPage.SelectedValueIndex := 0;
    if ResumeFresh then
    begin
      ExistingPage.SelectedValueIndex := 1;
      ExistingPage.CheckListBox.Enabled := False;
      ExistingPage.SubCaptionLabel.Caption := 'A committed Fresh reinstall is paused. Setup will resume completed Windows effects without repeating broad cleanup.';
    end;

    KeepDataPage := CreateInputOptionPage(ExistingPage.ID,
      'Keep your OFEnhancer data?', 'Choose what should happen to local desktop data.',
      'Keeping it preserves settings, catalogue, thumbnails, Google connection, and history. Windows uninstall does not prove Chrome extension removal.', False, False);
    KeepDataPage.Add('Keep settings, catalogue, and history');
    KeepDataPage.Values[0] := True;
  end;

  if ExistingPage <> nil then FreshAfterID := ExistingPage.ID else FreshAfterID := wpWelcome;
  FreshPage := CreateCustomPage(FreshAfterID, 'Confirm Fresh reinstall',
    'Windows cleanup completes first; Chrome remains a separate guided task.');
  FreshSummary := TNewStaticText.Create(FreshPage.Surface);
  FreshSummary.Parent := FreshPage.Surface;
  FreshSummary.AutoSize := False;
  FreshSummary.WordWrap := True;
  FreshSummary.Font.Style := [fsBold];
  FreshSummary.SetBounds(0, 8, FreshPage.SurfaceWidth, 48);
  FreshSummary.Caption := 'Fresh reinstall deletes OFEnhancer-owned desktop state. It does not claim that Chrome was removed.';
  FreshScope := TNewStaticText.Create(FreshPage.Surface);
  FreshScope.Parent := FreshPage.Surface;
  FreshScope.AutoSize := False;
  FreshScope.WordWrap := True;
  FreshScope.SetBounds(0, 68, FreshPage.SurfaceWidth, 170);
  FreshScope.Caption :=
    'Windows cleanup:' + #13#10 +
    '• settings, catalogue, credentials, checkpoints, WebView2 data, and obsolete installed files' + #13#10 + #13#10 +
    'After Windows installation:' + #13#10 +
    '• OFEnhancer opens one guided Chrome task' + #13#10 +
    '• the previous extension remains denied desktop access' + #13#10 +
    '• Chrome completion requires a genuine replacement installation';
end;

function ValidExistingUninstaller(): Boolean;
var
  Candidate, Name: String;
begin
  Result := False;
  if Trim(ExistingInstallRoot) = '' then Exit;
  Candidate := Trim(ExistingUninstaller);
  if (Length(Candidate) > 1) and (Candidate[1] = '"') and (Candidate[Length(Candidate)] = '"') then
    Candidate := Copy(Candidate, 2, Length(Candidate) - 2);
  if (Pos('"', Candidate) > 0) or (ExtractFileDrive(Candidate) = '') then Exit;
  ExistingInstallRoot := RemoveBackslashUnlessRoot(ExpandFileName(ExistingInstallRoot));
  Candidate := ExpandFileName(Candidate);
  Name := Lowercase(ExtractFileName(Candidate));
  ExistingUninstallerPath := Candidate;
  Result :=
    (CompareText(ExistingInstallRoot, RemoveBackslashUnlessRoot(ExpandFileName(WizardDirValue))) = 0) and
    (CompareText(ExistingInstallRoot, RemoveBackslashUnlessRoot(ExtractFileDir(Candidate))) = 0) and
    (Length(Name) = 12) and (Copy(Name, 1, 5) = 'unins') and
    (Name[6] >= '0') and (Name[6] <= '9') and
    (Name[7] >= '0') and (Name[7] <= '9') and
    (Name[8] >= '0') and (Name[8] <= '9') and (Copy(Name, 9, 4) = '.exe');
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
begin
  Result := '';
  if MaintenanceStatus = 3 then
  begin
    Result := 'The saved installation checkpoint could not be read. ' + MaintenanceError;
    Exit;
  end;
  if not IsFreshReset() then Exit;
  { Validate registry paths before creating any reset obligation. Missing files
    are handled separately after the helper verifies the product manifest. }
  if ExistingInstall() and not ValidExistingUninstaller() then
  begin
    Result := 'The registered uninstall path differs from the selected OFEnhancer folder. Select ' + ExistingInstallRoot + ' to repair this installation. No cleanup was started.';
    Exit;
  end;
  if not ExtractFreshMaintenance() or not RunFreshHelper('--fresh-reinstall-plan', ExitCode) or (ExitCode <> 0) then
  begin
    Result := 'Fresh reinstall could not prepare or resume Windows cleanup. ' + MaintenanceError;
    Exit;
  end;
  if not RunFreshHelper('--fresh-reinstall-stop-applications', ExitCode) or (ExitCode <> 0) then
  begin
    Result := 'Windows cleanup paused before removing files. ' + MaintenanceError;
    Exit;
  end;
  if not RunFreshHelper('--fresh-reinstall-needs-uninstall', ExitCode) or ((ExitCode <> 0) and (ExitCode <> 1)) then
  begin
    Result := 'Setup could not read the uninstall checkpoint. ' + MaintenanceError;
    Exit;
  end;
  if (ExitCode = 0) and ExistingInstall() then
  begin
    if not FileExists(ExistingUninstallerPath) then
      Log('Previous uninstaller is missing. Repairing the verified product root directly.')
    else if not Exec(ExistingUninstallerPath, '/SILENT /NORESTART', ExistingInstallRoot, SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
    begin
      Result := 'The verified previous OFEnhancer uninstaller failed. The resumable Windows transaction was preserved.';
      Exit;
    end;
  end;
  if not RunFreshHelper('--fresh-reinstall-previous-package-removed', ExitCode) or (ExitCode <> 0) then
  begin
    Result := 'Setup could not checkpoint removal of the previous Windows package. Rerun this installer to resume.';
    Exit;
  end;
  if not RunFreshHelper('--fresh-reinstall-clean', ExitCode) or (ExitCode <> 0) then
    Result := 'Windows cleanup paused; completed steps will not repeat. ' + MaintenanceError;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ExitCode: Integer;
begin
  if (CurStep = ssPostInstall) and IsFreshReset() then
    if not Exec(ExpandConstant('{app}\desktop\OFEnhancer.Desktop.exe'),
      '--fresh-reinstall-installed --install-root "' + ExpandConstant('{app}') + '" --package-version 0.20.72',
      '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
      RaiseException('The Windows package was copied, but verification or durable Chrome handoff failed. Run this installer again to resume.');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (KeepDataPage <> nil) and (PageID = KeepDataPage.ID) and
    (ResumeFresh or (ExistingPage.SelectedValueIndex <> 2));
  if (FreshPage <> nil) and (PageID = FreshPage.ID) then Result := not IsFreshReset();
  if ResumeFresh and (PageID = wpSelectDir) then Result := True;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (FreshPage <> nil) and (CurPageID = FreshPage.ID) then
  begin
    WizardForm.NextButton.Width := ScaleX(148);
    WizardForm.NextButton.Left := WizardForm.CancelButton.Left - WizardForm.NextButton.Width - ScaleX(8);
    WizardForm.BackButton.Left := WizardForm.NextButton.Left - WizardForm.BackButton.Width - ScaleX(8);
    WizardForm.NextButton.Caption := 'Start Fresh reinstall';
  end
  else
  begin
    WizardForm.NextButton.Left := OriginalNextLeft;
    WizardForm.NextButton.Width := OriginalNextWidth;
    WizardForm.BackButton.Left := OriginalBackLeft;
    if CurPageID = wpFinished then WizardForm.NextButton.Caption := SetupMessage(msgButtonFinish)
    else WizardForm.NextButton.Caption := SetupMessage(msgButtonNext);
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  ExitCode: Integer;
begin
  Result := True;
  if (KeepDataPage <> nil) and (CurPageID = KeepDataPage.ID) then
  begin
    if not ValidExistingUninstaller() or not FileExists(ExistingUninstallerPath) then
    begin
      MsgBox('The previous uninstaller is missing or invalid. Choose Update or reinstall to repair it while keeping your data, then uninstall.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    if (not KeepDataPage.Values[0]) and (not ExtractFreshMaintenance()) then
    begin
      MsgBox('Windows could not prepare verified OFEnhancer data cleanup. Nothing was removed.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    if not Exec(ExistingUninstallerPath, '/SILENT /NORESTART', ExistingInstallRoot, SW_SHOW, ewWaitUntilTerminated, ExitCode) then
      MsgBox('Windows could not start the existing uninstaller: ' + SysErrorMessage(ExitCode), mbError, MB_OK)
    else if ExitCode <> 0 then MsgBox('OFEnhancer could not be uninstalled. Your data was not removed.', mbError, MB_OK)
    else
    begin
      if not KeepDataPage.Values[0] then
        if not RunFreshHelper('--uninstall-clean-data', ExitCode) or (ExitCode <> 0) then
          MsgBox('OFEnhancer was uninstalled, but verified desktop data cleanup did not finish. Chrome was not changed.', mbError, MB_OK);
      ExistingUninstallCompleted := True;
      WizardForm.Close;
    end;
    Result := False;
  end;
end;

procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  if ExistingUninstallCompleted then Confirm := False;
end;

function ShouldDeleteUserData(): Boolean;
begin
  Result := RemoveUserData;
end;

procedure InitializeUninstallProgressForm();
var
  ButtonLabels: TArrayOfString;
begin
  if UninstallSilent then Exit;
  SetArrayLength(ButtonLabels, 2);
  ButtonLabels[0] := 'Keep my data (recommended)' + #13#10 + 'Preserve settings, catalogue, thumbnails, Google connection, and history.';
  ButtonLabels[1] := 'Remove my desktop data' + #13#10 + 'Delete only verified OFEnhancer-owned Windows data. Chrome is not reset.';
  RemoveUserData := TaskDialogMsgBox('Keep your OFEnhancer data?',
    'Windows uninstall does not prove or perform Chrome extension removal.', mbConfirmation,
    MB_YESNO, ButtonLabels, 0) = IDNO;
end;
