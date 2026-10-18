'use strict';
require('./originalGuidesV12Build.cjs').main().catch(e=>{console.error(e.code||'V12_BUILD_FAILED');process.exitCode=1;});
