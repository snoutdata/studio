;---------------------------------------------------------------------------------------------
;  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
;  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
;---------------------------------------------------------------------------------------------

; SnoutData's hooks into electron-builder's NSIS installer. electron-builder finds this file by
; name in build/ and prepends it to its own template, so every macro here is defined before the
; template asks whether it exists.
;
; STAGED UPDATES. Run as
;
;     SnoutData-Setup-X.exe /S --snout-stage=<dir>
;
; the installer only unpacks the app, and its uninstaller, into <dir> and exits: no app-running
; check (so the running app is not killed), no uninstall of the live install, no registry, no
; shortcuts, no relaunch. The running app does this in the background as soon as an update has
; downloaded (src/main/stagedUpdate.ts), so Restart is a folder swap rather than a reinstall,
; which is how VSCode restarts in seconds. Any other invocation is the stock installer.
;
; NEVER REMOVE THE STAGE BRANCH. A staging app runs the NEXT version's installer with this flag,
; and an installer that does not know it would do a full install over the running app.

; Defining customCheckAppRunning makes the template skip its own include of these and its
; `Var pid`, which its _CHECK_APP_RUNNING (called below, and by the uninstaller) still needs.
!include "getProcessInfo.nsh"
Var pid

; A function rather than the template's extraction macros: those declare variables and labels,
; and inserting them a second time into the install section does not compile. The payload and
; the uninstaller are the same files the section adds, which NSIS stores once. Defined through
; customHeader because the template registers the Nsis7z plugin after this file is read.
!macro customHeader
	!ifndef BUILD_UNINSTALLER
	Function snoutStage
		Pop $R9
		StrCpy $INSTDIR $R9
		RMDir /r $INSTDIR
		CreateDirectory $INSTDIR
		SetOutPath $INSTDIR
		!ifdef APP_64
			!ifdef COMPRESS
				SetCompress off
			!endif
			File /oname=$PLUGINSDIR\app-64.${COMPRESSION_METHOD} "${APP_64}"
			!ifdef COMPRESS
				SetCompress "${COMPRESS}"
			!endif
			; Straight into the empty stage. The stock path extracts to a temp folder and copies, so
			; overwriting a live install is all-or-nothing; there is nothing here to overwrite.
			Nsis7z::Extract "$PLUGINSDIR\app-64.${COMPRESSION_METHOD}"
			File "/oname=$INSTDIR\${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"
			; Written last, so the app can tell a whole stage from one interrupted half way (which is
			; never swapped in), and takes from it what the swap writes to the uninstall key.
			FileOpen $R8 "$INSTDIR\.snout-staged" w
			FileWrite $R8 "${VERSION}$\r$\n${UNINSTALL_APP_KEY}$\r$\n${UNINSTALL_DISPLAY_NAME}$\r$\n"
			FileClose $R8
		!endif
	FunctionEnd
	!endif
!macroend

!macro customCheckAppRunning
	!ifndef BUILD_UNINSTALLER
		${StdUtils.GetParameter} $R9 "snout-stage" ""
		${if} $R9 != ""
			Push $R9
			Call snoutStage
			!insertmacro quitSuccess
		${endIf}
	!endif
	!insertmacro _CHECK_APP_RUNNING
!macroend
