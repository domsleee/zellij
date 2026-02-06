use crate::consts::WEBSERVER_SOCKET_PATH;
use crate::errors::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, BufWriter, Write};

#[cfg(unix)]
use interprocess::local_socket::LocalSocketStream;
#[cfg(unix)]
use std::os::unix::fs::FileTypeExt;

#[cfg(windows)]
use crate::windows_utils::named_pipe::{Pipe, PipeStream};

pub fn shutdown_all_webserver_instances() -> Result<()> {
    let entries = fs::read_dir(&*WEBSERVER_SOCKET_PATH)?;

    for entry in entries {
        let entry = entry?;
        let path = entry.path();

        if let Some(file_name) = path.file_name() {
            if let Some(_file_name_str) = file_name.to_str() {
                #[cfg(unix)]
                {
                    let metadata = entry.metadata()?;
                    let file_type = metadata.file_type();
                    if file_type.is_socket() {
                        if let Ok(mut sender) = create_webserver_sender(path.to_str().unwrap_or("")) {
                            let _ = send_webserver_instruction(
                                &mut sender,
                                InstructionForWebServer::ShutdownWebServer,
                            );
                        }
                    }
                }
                #[cfg(windows)]
                {
                    // On Windows, check if the corresponding named pipe exists
                    if let Ok(mut sender) = create_webserver_sender(path.to_str().unwrap_or("")) {
                        let _ = send_webserver_instruction(
                            &mut sender,
                            InstructionForWebServer::ShutdownWebServer,
                        );
                    }
                }
            }
        }
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum InstructionForWebServer {
    ShutdownWebServer,
}

#[cfg(unix)]
pub fn create_webserver_sender(path: &str) -> Result<BufWriter<LocalSocketStream>> {
    let stream = LocalSocketStream::connect(path)?;
    Ok(BufWriter::new(stream))
}

#[cfg(windows)]
pub fn create_webserver_sender(path: &str) -> Result<BufWriter<PipeStream>> {
    let pipe = Pipe::new(std::path::Path::new(path));
    let stream = pipe.connect()?;
    Ok(BufWriter::new(stream))
}

#[cfg(unix)]
pub fn send_webserver_instruction(
    sender: &mut BufWriter<LocalSocketStream>,
    instruction: InstructionForWebServer,
) -> Result<()> {
    rmp_serde::encode::write(sender, &instruction)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    sender.flush()?;
    Ok(())
}

#[cfg(windows)]
pub fn send_webserver_instruction(
    sender: &mut BufWriter<PipeStream>,
    instruction: InstructionForWebServer,
) -> Result<()> {
    rmp_serde::encode::write(sender, &instruction)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    sender.flush()?;
    Ok(())
}
