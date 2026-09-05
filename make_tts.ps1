param(
    [string]$text,
    [string]$outFile
)

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 0
$synth.Volume = 100
$synth.SetOutputToWaveFile($outFile)
$synth.Speak($text)
$synth.Dispose()
