-- Auditoria por usuário e data: limites do login (conta inteira), do envio de PDF por e-mail e da IA
CREATE INDEX "audit_log_user_at_idx" ON "audit_log" USING btree ("user_id","at");
