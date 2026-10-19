; 萤火 Agent 工作台 · installer skin, design B「在梦与火之间」(流萤 + 萨姆).
;
; electron-builder includes this file before MUI2.nsh, so the defines below configure the Modern UI.
; Every page gets its dark colours from a SHOW callback, wired through electron-builder's hooks:
;   welcome, finish     customWelcomePage / customFinishPage, customUnWelcomePage / customUninstallPage
;   license, directory  skipPageIfUpdated, redefined in installer-pages.nsh
;   install mode        customInstallMode
;   install files       customPageAfterChangeDir; MUI_UNPAGE_INSTFILES, redefined in installer-pages.nsh
; Art: build/installer/{sidebar,header}.bmp (scripts/gen-installer-art.py), 3x masters that are scaled
; to the real control size at runtime, so they stay sharp at any display scale.

ManifestDPIAware true

!define FF_BG "0A0F14"     ; header, welcome and finish pages
!define FF_PAGE "0D141B"   ; inner pages and the button bar
!define FF_FIELD "131B23"  ; edit box, license text, details list
!define FF_TEXT "E2ECEA"
!define FF_TITLE "E6FFF8"
!define FF_DIM "93A39F"
!define FF_LIME "B5F26B"
!define FF_LINE "2F402B"   ; hairlines: lime at 20% over FF_PAGE
; the same colours as COLORREF (0x00BBGGRR) for window messages
!define FF_BG_REF 0x00140F0A
!define FF_FIELD_REF 0x00231B13
!define FF_TEXT_REF 0x00EAECE2
!define FF_LIME_REF 0x006BF2B5
!define FF_TRACK_REF 0x002B231D

!define MUI_BGCOLOR "${FF_BG}"
!define MUI_TEXTCOLOR "${FF_TEXT}"
!define MUI_FORCECLASSICCONTROLS          ; un-themed check boxes, so their text can be coloured
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"
!ifdef BUILD_UNINSTALLER ; that pass also emits an (unused) .onGUIInit, so hook only the side it builds
  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.ffGuiInit
!else
  !define MUI_CUSTOMFUNCTION_GUIINIT ffGuiInit
!endif
!ifdef MUI_HEADERIMAGE_RIGHT
  !undef MUI_HEADERIMAGE_RIGHT              ; the header art sits left of the page title
!endif

; Page texts in the skin's wording (MUI's language file only fills in strings that are not defined yet)
!define MUI_TEXT_LICENSE_TITLE "使用条款"
!define MUI_TEXT_LICENSE_SUBTITLE "安装「萤火 Agent 工作台」之前，请先阅读以下条款。"
!define MUI_INNERTEXT_LICENSE_TOP "按 PgDn 键可以向下翻页。"
!define MUI_INNERTEXT_LICENSE_BOTTOM "同意以上条款，请点「我同意」继续安装。不同意则无法安装。"
!define MUI_TEXT_DIRECTORY_SUBTITLE "选择「萤火 Agent 工作台」的安装文件夹。"
!define MUI_TEXT_INSTALLING_SUBTITLE "「萤火 Agent 工作台」正在安装，请稍候。"

!macro customWelcomePage
  !include "installer-pages.nsh"

  ; The elevated copy that UAC starts for an all-users install begins again at page one: it has
  ; already been welcomed. (Same for an in-app update, like electron-builder's license page.)
  Function ffWelcomePre
    ${If} ${UAC_IsInnerInstance}
    ${OrIf} ${isUpdated}
      Abort
    ${EndIf}
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE ffWelcomePre
  !define MUI_WELCOMEPAGE_TITLE "在梦与火之间"
  !define MUI_WELCOMEPAGE_TEXT "安装「萤火 Agent 工作台」。$\r$\n$\r$\n她在梦里是温柔的少女，醒来是燃烧着前行的萨姆。$\r$\n$\r$\n这个工作台也一样：闲聊时轻声细语，工作时全力以赴。$\r$\n$\r$\n点「下一步」，开始安装。"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW ffWelcomeShow
  !insertmacro MUI_PAGE_WELCOME
  ; read by the directory page further on (no page in between uses it)
  !define MUI_DIRECTORYPAGE_TEXT_TOP "「萤火 Agent 工作台」将安装到下面的文件夹。要换个位置，点「浏览」选择其他文件夹；点「安装」开始安装。"
!macroend

!macro customInstallMode
  ; expanded inside the install-mode page's own function, before it calls its SHOW callback
  !ifndef MUI_PAGE_CUSTOMFUNCTION_SHOW
    !ifdef BUILD_UNINSTALLER
      !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ffDarkPage
    !else
      !define MUI_PAGE_CUSTOMFUNCTION_SHOW ffDarkPage
    !endif
  !endif
!macroend

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW ffDarkPage
!macroend

; electron-builder's default finish page, plus our texts and SHOW callback
!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif
  !define MUI_FINISHPAGE_TITLE "安装完成"
  !define MUI_FINISHPAGE_TEXT "「萤火 Agent 工作台」已经装好了。$\r$\n$\r$\n闲聊时她轻声细语，工作时全力以赴。点「完成」退出安装程序。"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW ffFinishShow
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customUnWelcomePage
  !include "installer-pages.nsh"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ffWelcomeShow
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

!macro customUninstallPage
  ; inserted between the uninstall-files page and the finish page
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ffFinishShow
!macroend

!macro customHeader
  ; display name only: registry keys and paths use electron-builder's PRODUCT_NAME / APP_* defines.
  ; common.nsh set both already; overriding them is intended (warning 6029 "specified multiple times")
  !pragma warning push
  !pragma warning disable 6029
  Name "萤火 Agent 工作台"
  BrandingText "在梦与火之间 · 萤火 ${VERSION}"
  !pragma warning pop
  !ifndef BUILD_UNINSTALLER
    Caption "萤火 Agent 工作台 ${VERSION} 安装"
  !endif
  SetFont /LANG=${LANG_SIMPCHINESE} "Microsoft YaHei UI" 9
  ; the MUI variables used below exist once the pages are inserted, which is before customHeader
  !ifdef BUILD_UNINSTALLER
    !insertmacro FF_FUNCTIONS "un."
  !else
    !insertmacro FF_FUNCTIONS ""
  !endif
!macroend

; Each makensis pass (installer, uninstaller) must define only the functions it calls, because
; electron-builder builds with warnings as errors and an unused function is a warning.
!macro FF_FUNCTIONS UN
  Var ffSideBmp

  ; Draw a BMP master onto a static bitmap control at the control's real pixel size, HALFTONE
  ; filtered and cover-fitted. Trimming happens on the left / bottom: the art fades into the page
  ; colour on the right and Firefly's face is at the top.
  ; Push <control>, Push <bmp path>, Call ffSetSharpImage, Pop <new HBITMAP, or 0>
  Function ${UN}ffSetSharpImage
    Exch $1
    Exch
    Exch $0
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    Push $7
    Push $8
    Push $9
    Push $R0
    Push $R1
    Push $R2
    Push $R3
    Push $R4
    Push $R5
    Push $R6
    Push $R7
    Push $R8
    StrCpy $9 0
    System::Call '*(i,i,i,i) p.r2'
    System::Call 'user32::GetClientRect(p r0, p r2)'
    System::Call '*$2(i,i,i.r3,i.r4)'
    System::Free $2
    System::Call 'user32::LoadImageW(p 0, w r1, i 0, i 0, i 0, i 0x2010) p.r5' ; IMAGE_BITMAP, LR_LOADFROMFILE | LR_CREATEDIBSECTION
    ${If} $3 > 0
    ${AndIf} $4 > 0
    ${AndIf} $5 != 0
      System::Call '*(i,i,i,i,&i2,&i2,p) p.r2'
      System::Call 'gdi32::GetObjectW(p r5, i 24, p r2)'
      System::Call '*$2(i,i.r6,i.r7)'
      System::Free $2
      ; source rectangle: x $R3, y $8, width $R2, height $R0
      IntOp $R0 $6 * $4
      IntOp $R1 $3 * $7
      StrCpy $8 0
      ${If} $R0 > $R1
        IntOp $R2 $7 * $3
        IntOp $R2 $R2 / $4
        IntOp $R3 $6 - $R2
        StrCpy $R0 $7
      ${Else}
        StrCpy $R2 $6
        StrCpy $R3 0
        IntOp $R0 $6 * $4
        IntOp $R0 $R0 / $3
      ${EndIf}
      System::Call 'user32::GetDC(p 0) p.R4'
      System::Call 'gdi32::CreateCompatibleDC(p R4) p.R5'
      System::Call 'gdi32::CreateCompatibleDC(p R4) p.R6'
      System::Call 'gdi32::CreateCompatibleBitmap(p R4, i r3, i r4) p.r9'
      System::Call 'gdi32::SelectObject(p R5, p r5) p.R7'
      System::Call 'gdi32::SelectObject(p R6, p r9) p.R8'
      System::Call 'gdi32::SetStretchBltMode(p R6, i 4)' ; HALFTONE
      System::Call 'gdi32::SetBrushOrgEx(p R6, i 0, i 0, p 0)'
      System::Call 'gdi32::StretchBlt(p R6, i 0, i 0, i r3, i r4, p R5, i R3, i r8, i R2, i R0, i 0x00CC0020)' ; SRCCOPY
      System::Call 'gdi32::SelectObject(p R5, p R7)'
      System::Call 'gdi32::SelectObject(p R6, p R8)'
      System::Call 'gdi32::DeleteDC(p R5)'
      System::Call 'gdi32::DeleteDC(p R6)'
      System::Call 'user32::ReleaseDC(p 0, p R4)'
      SendMessage $0 0x0172 0 $9 ; STM_SETIMAGE, IMAGE_BITMAP
    ${EndIf}
    ${If} $5 != 0
      System::Call 'gdi32::DeleteObject(p r5)'
    ${EndIf}
    StrCpy $1 $9
    Pop $R8
    Pop $R7
    Pop $R6
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
    Pop $9
    Pop $8
    Pop $7
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $0
    Exch $1
  FunctionEnd

  ; Outer window: caption, button bar, header, hairlines, buttons. Runs once, after MUI's own init.
  Function ${UN}ffGuiInit
    Push $0
    ; dark caption on Windows 10 2004+ / 11; the colour attributes are Windows 11 only
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i ${FF_BG_REF}, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 36, *i ${FF_TEXT_REF}, i 4)'

    SetCtlColors $HWNDPARENT "${FF_TEXT}" "${FF_PAGE}"
    SetCtlColors $mui.Header.Text "${FF_TITLE}" "${FF_BG}"
    SetCtlColors $mui.Header.SubText "${FF_LIME}" "${FF_BG}"

    ; Separators: an etched static keeps painting etched after a restyle, so flat lines of our colour
    ; take the place of the header line (1036) and the full-width bottom line (1045). The short bottom
    ; line (1035) that MUI shows on inner pages goes away; the full-width one now shows on every page.
    Push 1036
    Call ${UN}ffFlatLine
    Push 1045
    Call ${UN}ffFlatLine
    System::Call 'user32::SetWindowPos(p $mui.Line.Standard, p 0, i 0, i -100, i 0, i 0, i 0x15)' ; off-screen

    ; Buttons: dark theme, painted on the bar colour (else a light square shows around the rounded
    ; face), and Back pulled away from Next so the two do not read as one double-wide button.
    ; Branding text: below the line, left of the buttons and centred on them, in the dim colour.
    ; MUI's branding "background" twin is only there to break the old line, so it goes off-screen.
    System::Call 'uxtheme::SetWindowTheme(p $mui.Button.Next, w "DarkMode_Explorer", p 0)'
    System::Call 'uxtheme::SetWindowTheme(p $mui.Button.Back, w "DarkMode_Explorer", p 0)'
    System::Call 'uxtheme::SetWindowTheme(p $mui.Button.Cancel, w "DarkMode_Explorer", p 0)'
    SetCtlColors $mui.Button.Next "${FF_TEXT}" "${FF_PAGE}"
    SetCtlColors $mui.Button.Back "${FF_TEXT}" "${FF_PAGE}"
    SetCtlColors $mui.Button.Cancel "${FF_TEXT}" "${FF_PAGE}"
    System::Call 'user32::SetWindowPos(p $mui.Branding.Background, p 0, i 0, i -100, i 0, i 0, i 0x15)'
    EnableWindow $mui.Branding.Text 1 ; a disabled static ignores its colours
    SetCtlColors $mui.Branding.Text "${FF_DIM}" "${FF_PAGE}"
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    Push $7
    System::Call '*(i,i,i,i) p.r0'
    System::Call 'user32::GetWindowRect(p $mui.Branding.Text, p r0)'
    System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p r0, i 2)'
    System::Call '*$0(i.r1,i.r2,i,i.r3)' ; text left, top, bottom
    System::Call 'user32::GetWindowRect(p $mui.Button.Next, p r0)'
    System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p r0, i 2)'
    System::Call '*$0(i,i.r4,i,i.r5)' ; button top, bottom
    System::Call 'user32::GetWindowRect(p $mui.Button.Back, p r0)'
    System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p r0, i 2)'
    System::Call '*$0(i.r6,i.r7)' ; back button left, top
    System::Free $0
    IntOp $0 $5 - $4
    IntOp $0 $0 / 4  ; gap between Back and Next: a quarter of the button height
    IntOp $6 $6 - $0
    System::Call 'user32::SetWindowPos(p $mui.Button.Back, p 0, i r6, i r7, i 0, i 0, i 0x15)' ; SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
    IntOp $3 $3 - $2 ; text height
    IntOp $2 $5 - $4
    IntOp $2 $2 - $3
    IntOp $2 $2 / 2
    IntOp $2 $2 + $4 ; top: centred on the buttons
    IntOp $6 $6 - $1
    IntOp $6 $6 - $0 ; width: up to the back button
    System::Call 'user32::SetWindowPos(p $mui.Branding.Text, p 0, i r1, i r2, i r6, i r3, i 0x14)' ; SWP_NOZORDER | SWP_NOACTIVATE
    Pop $7
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1

    Push $mui.Header.Image
    Push "$PLUGINSDIR\modern-header.bmp"
    Call ${UN}ffSetSharpImage
    Pop $0
    Pop $0
  FunctionEnd

  ; Push <control id>: put a plain static filled with FF_LINE where that etched line is, just below it
  ; in the z-order (so full-window pages still cover it), and move the original off-screen.
  Function ${UN}ffFlatLine
    Exch $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    GetDlgItem $0 $HWNDPARENT $0
    System::Call '*(i,i,i,i) p.r1'
    System::Call 'user32::GetWindowRect(p r0, p r1)'
    System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p r1, i 2)'
    System::Call '*$1(i.r2,i.r3,i.r4,i.r5)'
    System::Free $1
    IntOp $4 $4 - $2
    IntOp $5 $5 - $3
    System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x50000000, i r2, i r3, i r4, i r5, p $HWNDPARENT, p 0, p 0, p 0) p.r1' ; WS_CHILD | WS_VISIBLE
    SetCtlColors $1 "${FF_LINE}" "${FF_LINE}"
    System::Call 'user32::SetWindowPos(p r1, p r0, i 0, i 0, i 0, i 0, i 0x13)' ; after the original: SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
    System::Call 'user32::SetWindowPos(p r0, p 0, i 0, i -100, i 0, i 0, i 0x15)' ; off-screen: SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; MUI hides the branding text on full-window pages because its old spot was under the page; it now
  ; sits in the button bar, so it stays (MUI shows it again when the page is left).
  Function ${UN}ffWelcomeShow
    SetCtlColors $mui.WelcomePage.Title "${FF_TITLE}" "${FF_BG}"
    ShowWindow $mui.Branding.Text ${SW_SHOW}
    Push $mui.WelcomePage.Image
    Call ${UN}ffSideArt
  FunctionEnd

  Function ${UN}ffFinishShow
    SetCtlColors $mui.FinishPage.Title "${FF_TITLE}" "${FF_BG}"
    ShowWindow $mui.Branding.Text ${SW_SHOW}
    Push $mui.FinishPage.Image
    Call ${UN}ffSideArt
  FunctionEnd

  ; Welcome and finish pages: replace MUI's stretched sidebar with the sharp one. The previous
  ; page's control is gone by now, so its bitmap can be freed.
  Function ${UN}ffSideArt
    Exch $0
    ${If} $ffSideBmp != ""
    ${AndIf} $ffSideBmp != 0
      System::Call 'gdi32::DeleteObject(p $ffSideBmp)'
    ${EndIf}
    Push $0
    Push "$PLUGINSDIR\modern-wizard.bmp"
    Call ${UN}ffSetSharpImage
    Pop $ffSideBmp
    Pop $0
  FunctionEnd

  ; Inner pages: colour the page dialog and every control on it. All page dialogs are coloured: when a
  ; custom (nsDialogs) page builds itself, the previous page's dialog has not been destroyed yet.
  Function ${UN}ffDarkPage
    Push $0
    Push $1
    StrCpy $0 0
    ${Do}
      FindWindow $0 "#32770" "" $HWNDPARENT $0
      ${If} $0 == 0
        ${ExitDo}
      ${EndIf}
      SetCtlColors $0 "${FF_TEXT}" "${FF_PAGE}"
      StrCpy $1 0
      ${Do}
        FindWindow $1 "" "" $0 $1
        ${If} $1 == 0
          ${ExitDo}
        ${EndIf}
        Push $1
        Call ${UN}ffDarkControl
      ${Loop}
    ${Loop}
    Pop $1
    Pop $0
  FunctionEnd

  Function ${UN}ffDarkControl
    Exch $0
    Push $1
    Push $2
    System::Call 'user32::GetClassNameW(p r0, w .r1, i ${NSIS_MAX_STRLEN})'
    ${If} $1 == "Static"
      ; solid, not transparent: the status line changes text and must repaint its background
      SetCtlColors $0 "${FF_TEXT}" "${FF_PAGE}"
    ${ElseIf} $1 == "Button"
      System::Call 'user32::GetWindowLongW(p r0, i -16) i.r2'
      IntOp $2 $2 & 0xF ; BS_TYPEMASK
      ${If} $2 <= 1
        System::Call 'uxtheme::SetWindowTheme(p r0, w "DarkMode_Explorer", p 0)'
        SetCtlColors $0 "${FF_TEXT}" "${FF_PAGE}"
      ${Else}
        ; check box, radio button, group box: the classic look is the one that honours text colour
        System::Call 'uxtheme::SetWindowTheme(p r0, w " ", w " ")'
        SetCtlColors $0 "${FF_TEXT}" "${FF_PAGE}"
      ${EndIf}
    ${ElseIf} $1 == "Edit"
      SetCtlColors $0 "${FF_TEXT}" "${FF_FIELD}"
      System::Call 'uxtheme::SetWindowTheme(p r0, w "DarkMode_CFD", p 0)'
    ${ElseIf} $1 == "msctls_progress32"
      System::Call 'uxtheme::SetWindowTheme(p r0, w " ", w " ")'
      SendMessage $0 0x0409 0 ${FF_LIME_REF}  ; PBM_SETBARCOLOR
      SendMessage $0 0x2001 0 ${FF_TRACK_REF} ; PBM_SETBKCOLOR
    ${ElseIf} $1 == "SysListView32"
      SendMessage $0 0x1001 0 ${FF_FIELD_REF} ; LVM_SETBKCOLOR
      SendMessage $0 0x1026 0 ${FF_FIELD_REF} ; LVM_SETTEXTBKCOLOR
      SendMessage $0 0x1024 0 ${FF_TEXT_REF}  ; LVM_SETTEXTCOLOR
      System::Call 'uxtheme::SetWindowTheme(p r0, w "DarkMode_Explorer", p 0)'
    ${Else}
      StrCpy $2 $1 8
      ${If} $2 == "RichEdit" ; the license text
        SendMessage $0 0x0443 0 ${FF_FIELD_REF} ; EM_SETBKGNDCOLOR
        ; CHARFORMATW { cbSize 92, dwMask CFM_COLOR, ..., crTextColor, ... } applied with SCF_ALL
        System::Call '*(i 92, i 0x40000000, i 0, i 0, i 0, i ${FF_TEXT_REF}, &i2 0, &w32 "", &i2 0) p.r2'
        SendMessage $0 0x0444 4 $2 ; EM_SETCHARFORMAT
        System::Free $2
        System::Call 'uxtheme::SetWindowTheme(p r0, w "DarkMode_Explorer", p 0)'
      ${EndIf}
    ${EndIf}
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd
!macroend
