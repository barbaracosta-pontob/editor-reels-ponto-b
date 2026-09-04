@echo off
chcp 65001 >nul
title Ponto B - Diagnostico da maquina

:: ============================================================================
:: Coleta CPU, memoria, GPU e estado do CUDA e grava em diagnostico-maquina.txt
:: na mesma pasta. Somente LEITURA - nao instala nem altera nada.
::
:: Serve para decidir se a transcricao pode rodar na GPU (10-20x mais rapida
:: que a CPU) e qual concorrencia de render a maquina aguenta.
:: ============================================================================

set OUT=%~dp0diagnostico-maquina.txt

echo. > "%OUT%"
echo ==================================================== >> "%OUT%"
echo  DIAGNOSTICO DA MAQUINA - Ponto B Editor de Videos   >> "%OUT%"
echo  %DATE% %TIME%                                       >> "%OUT%"
echo ==================================================== >> "%OUT%"
echo. >> "%OUT%"

echo  Coletando dados... isso leva alguns segundos.
echo.

echo --- CPU --- >> "%OUT%"
powershell -NoProfile -Command "Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed | Format-List | Out-String -Width 200" >> "%OUT%" 2>&1

echo --- MEMORIA --- >> "%OUT%"
powershell -NoProfile -Command "$m=Get-CimInstance Win32_ComputerSystem; 'RAM total: ' + [math]::Round($m.TotalPhysicalMemory/1GB,1) + ' GB'" >> "%OUT%" 2>&1
echo. >> "%OUT%"

echo --- PLACAS DE VIDEO --- >> "%OUT%"
powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion,VideoProcessor | Format-List | Out-String -Width 200" >> "%OUT%" 2>&1

echo --- NVIDIA / CUDA --- >> "%OUT%"
where nvidia-smi >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo nvidia-smi encontrado: >> "%OUT%"
    nvidia-smi >> "%OUT%" 2>&1
) else (
    echo nvidia-smi NAO encontrado no PATH. >> "%OUT%"
    echo Isso normalmente significa que nao ha GPU NVIDIA ou o driver nao esta instalado. >> "%OUT%"
)
echo. >> "%OUT%"

echo --- CUDA_PATH / cuDNN --- >> "%OUT%"
echo CUDA_PATH=%CUDA_PATH% >> "%OUT%"
if exist "%ProgramFiles%\NVIDIA GPU Computing Toolkit\CUDA" (
    echo Toolkit CUDA encontrado. Versoes: >> "%OUT%"
    dir /b "%ProgramFiles%\NVIDIA GPU Computing Toolkit\CUDA" >> "%OUT%" 2>&1
) else (
    echo Toolkit CUDA nao encontrado em Program Files. >> "%OUT%"
)
echo. >> "%OUT%"

echo --- PYTHON DA TRANSCRICAO --- >> "%OUT%"
set PYEXE=%~dp0..\services\transcription\.venv\Scripts\python.exe
if exist "%PYEXE%" (
    "%PYEXE%" -c "import sys, ctranslate2; print('python', sys.version.split()[0]); print('ctranslate2', ctranslate2.__version__); print('GPUs CUDA visiveis para o ctranslate2:', ctranslate2.get_cuda_device_count())" >> "%OUT%" 2>&1
) else (
    echo .venv nao encontrada em services\transcription\.venv >> "%OUT%"
)
echo. >> "%OUT%"

echo ==================================================== >> "%OUT%"
echo  FIM                                                 >> "%OUT%"
echo ==================================================== >> "%OUT%"

echo.
echo  Pronto. Resultado salvo em:
echo  %OUT%
echo.
echo  A linha mais importante e a ultima: "GPUs CUDA visiveis para o ctranslate2".
echo.
pause
