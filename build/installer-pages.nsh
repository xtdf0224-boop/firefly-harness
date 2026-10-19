; Included from customWelcomePage / customUnWelcomePage in installer.nsh, after electron-builder's
; common.nsh and MUI2 are read. Two pages have no electron-builder hook in front of them, so the macro
; that inserts them is redefined here with the dark SHOW callback added.
!ifndef BUILD_UNINSTALLER
  ; skipPageIfUpdated comes right before the license and directory pages. The body is common.nsh's,
  ; plus the SHOW line. (A .html license would define its own SHOW callback and clash: keep it .txt.)
  !macroundef skipPageIfUpdated
  !macro skipPageIfUpdated
    !define UniqueID ${__LINE__}

    Function skipPageIfUpdated_${UniqueID}
      ${if} ${isUpdated}
        Abort
      ${endif}
    FunctionEnd

    !define MUI_PAGE_CUSTOMFUNCTION_PRE skipPageIfUpdated_${UniqueID}
    !ifndef MUI_PAGE_CUSTOMFUNCTION_SHOW
      !define MUI_PAGE_CUSTOMFUNCTION_SHOW ffDarkPage
    !endif
    !undef UniqueID
  !macroend
!else
  ; The uninstall-files page. Colouring it from the uninstall section would be too late: the section
  ; first runs the PowerShell "is the app running" probes. The body is MUI2's, plus the SHOW line.
  !macroundef MUI_UNPAGE_INSTFILES
  !macro MUI_UNPAGE_INSTFILES
    !verbose push
    !verbose ${MUI_VERBOSE}
    !insertmacro MUI_UNPAGE_INIT
    !ifndef MUI_PAGE_CUSTOMFUNCTION_SHOW
      !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ffDarkPage
    !endif
    !insertmacro MUI_PAGEDECLARATION_INSTFILES
    !verbose pop
  !macroend
!endif
