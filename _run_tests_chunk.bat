@echo off
setlocal
set ROOT=%~dp0
cd /d "%ROOT%"

set BIDDER=t_bidder.txt
set AUTOFILL=t_autofill.txt
set EDGE=t_edge.txt
set CAPTCHA=t_captcha.txt

> "%BIDDER%"   echo === BIDDER ===
> "%AUTOFILL%" echo === AUTOFILL ===
> "%EDGE%"     echo === EDGE ===
> "%CAPTCHA%"  echo === CAPTCHA ===

rem ---------- chunk 1: bidder ----------
call :runone "%BIDDER%" extension\fixtures\test_ats_detect.js              || goto :fail
call :runone "%BIDDER%" extension\fixtures\test_captcha_pass.js            || goto :fail
call :runone "%BIDDER%" extension\fixtures\test_captcha_vendor_engineer.js || goto :fail
call :runone "%BIDDER%" extension\fixtures\test_captcha_all_platforms.js   || goto :fail
call :runone "%BIDDER%" extension\fixtures\test_unattended_captcha.js      || goto :fail
call :runone "%BIDDER%" extension\fixtures\test_autofill_engine.js         || goto :fail
call :runone "%BIDDER%" extension\fixtures\test_fill_verify.js             || goto :fail
call :runone "%BIDDER%" extension\fixtures\test_bidder_queue_defaults.js   || goto :fail
call :runone "%BIDDER%" extension\fixtures\test_select_wait_loading.js     || goto :fail
call :runone "%BIDDER%" extension\fixtures\test_bidder_brain.js            || goto :fail
call :runone "%BIDDER%" extension\fixtures\test_bidder_fill_unit.js        || goto :fail
call :runone "%BIDDER%" extension\fixtures\test_bidder_page_bridge.js      || goto :fail
call :runone "%BIDDER%" extension\fixtures\test_bidder_ready_queue.js      || goto :fail
call :runone "%BIDDER%" extension\fixtures\test_bidder_onetrust_course.js  || goto :fail
call :runone "%BIDDER%" extension\fixtures\test_autofill_file_routing.js   || goto :fail
call :runone "%BIDDER%" extension\fixtures\test_autofill_select_radio.js   || goto :fail
call :runone "%BIDDER%" extension\fixtures\test_coreweave_reliability.js   || goto :fail
call :runone "%BIDDER%" extension\fixtures\test_snap_mcq_answers.js        || goto :fail
call :runone "%BIDDER%" extension\fixtures\test_update_state_success.js    || goto :fail
call :runone "%BIDDER%" extension\fixtures\test_lumi_bidder_prefs.js       || goto :fail

rem ---------- chunk 2: autofill ----------
call :runone "%AUTOFILL%" extension\fixtures\test_ats_classify_unit.js       || goto :fail
call :runone "%AUTOFILL%" extension\fixtures\test_education_fixed.js        || goto :fail
call :runone "%AUTOFILL%" extension\fixtures\test_latent_bugs.js             || goto :fail
call :runone "%AUTOFILL%" extension\fixtures\test_multi_ats.js               || goto :fail
call :runone "%AUTOFILL%" extension\fixtures\test_ats_detailed.js            || goto :fail
call :runone "%AUTOFILL%" extension\fixtures\test_all_platforms_all_types.js || goto :fail
call :runone "%AUTOFILL%" extension\fixtures\test_autofill_hard_cases.js     || goto :fail
call :runone "%AUTOFILL%" extension\fixtures\test_more_platforms.js          || goto :fail

rem ---------- chunk 3: edge ----------
call :runone "%EDGE%" extension\fixtures\test_more_edge_cases.js             || goto :fail

rem ---------- chunk 4: captcha ----------
call :runone "%CAPTCHA%" extension\fixtures\test_captcha_pass.js             || goto :fail
call :runone "%CAPTCHA%" extension\fixtures\test_captcha_vendor_engineer.js  || goto :fail
call :runone "%CAPTCHA%" extension\fixtures\test_captcha_all_platforms.js    || goto :fail
call :runone "%CAPTCHA%" extension\fixtures\test_more_edge_cases.js          || goto :fail
call :runone "%CAPTCHA%" extension\fixtures\test_unattended_captcha.js       || goto :fail

echo ALL_DONE > t_all.done
exit /b 0

:runone
echo. >> %1
echo ==== %2 ==== >> %1
node %2 >> %1 2>&1
if errorlevel 1 (
  echo !!!!! FAILED: %2 !!!!! >> %1
  exit /b 1
)
exit /b 0

:fail
echo BAIL_OUT > t_all.done
exit /b 1

