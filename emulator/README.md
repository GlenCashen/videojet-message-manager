# WSI + Markem NGPCL Emulator

Run:

```bash
python3 emulator.py --ui-port 8098
```

Open UI:

```text
http://localhost:8098
```

Markem / NGPCL tests:

```bash
printf '{~JR|}\r' | nc -w 2 127.0.0.1 21000 | xxd
printf '{~DR|}\r' | nc -w 2 127.0.0.1 21000 | xxd
printf '{~FR|Batch1|}\r' | nc -w 2 127.0.0.1 21000 | xxd
printf '{~FR|Batch|}\r' | nc -w 2 127.0.0.1 21000 | xxd
printf '{~JS0|9 Months.job|0|}\r' | nc -w 2 127.0.0.1 21000 | xxd
printf '{~JU0||0|Batch1|T0067|Batch|TBUNDRC-51|}\r' | nc -w 2 127.0.0.1 21000 | xxd
```

Expected text:

```text
{~JN0|Bundy 15 Month.job|}
{~DS0|0|1|0|0|0|2|0|000000000|06|1|}
{~FC0|Batch1|T0067|}
{~FC0|Batch|TBUNDRC-51|}
{~JS0|}
{~JU0|}
```
